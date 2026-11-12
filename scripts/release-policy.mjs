import * as filesystem from "node:fs";

/**
 * @typedef {{sha?: unknown, type?: unknown}} GitObject
 * @typedef {{tag_name?: unknown, draft?: unknown, prerelease?: unknown, ref?: unknown, object?: GitObject, head_sha?: unknown, head_branch?: unknown, event?: unknown, path?: unknown, status?: unknown, conclusion?: unknown}} PolicyData
 * @typedef {{owner: string, repo: string, tag?: string, ref?: string, tag_sha?: string, run_id?: number, per_page?: number, page?: number}} ReadArguments
 * @typedef {(args: ReadArguments) => Promise<{data: PolicyData | null | undefined}>} ReadObject
 * @typedef {{rest: {repos: {getReleaseByTag: ReadObject, getLatestRelease: ReadObject, listReleases: (args: ReadArguments) => Promise<{data: unknown}>}, git: {getRef: ReadObject, getTag: ReadObject}, actions: {getWorkflowRun: (args: ReadArguments) => Promise<{data: PolicyData}>}}}} PolicyGitHub
 * @typedef {{repo: {owner: string, repo: string}, ref: string, sha: string}} PolicyContext
 * @typedef {{info: (message: string) => void, setOutput: (name: string, value: string) => void}} PolicyCore
 * @typedef {{github: PolicyGitHub, context: PolicyContext, core: PolicyCore, env: NodeJS.ProcessEnv}} PolicyOptions
 */

/** @param {{github: PolicyGitHub, context: PolicyContext, core: PolicyCore, fs?: {readFileSync: (file: string, encoding: "utf8") => string}}} options */
export async function resolveReleaseVersion({ github, context, core, fs = filesystem }) {
  /** @param {string} file @returns {{version?: unknown, packages?: Record<string, {version?: unknown}>}} */
  const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
  const packageJson = readJson("package.json");
  const packageLock = readJson("package-lock.json");
  const version = packageJson.version;
  /** @param {unknown} value */
  const parseVersion = (value) => {
    if (typeof value !== 'string' || value.length > 256) return null;
    const match = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(value);
    return match && match[0] === value ? /** @type {string} */ (match[1]).split('.').map(BigInt) : null;
  };
  const candidate = typeof version === 'string' ? parseVersion(`v${version}`) : null;
  if (!candidate) {
    throw new Error(`package.json has an invalid release version: ${version}`);
  }
  const cargoVersion = fs
    .readFileSync("src-tauri/Cargo.toml", "utf8")
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const cargoLockVersion = fs
    .readFileSync("src-tauri/Cargo.lock", "utf8")
    .match(/\[\[package\]\]\s+name\s*=\s*"aiolm"\s+version\s*=\s*"([^"]+)"/m)?.[1];
  const declaredVersions = {
    "package.json": version,
    "package-lock.json": packageLock.packages?.[""]?.version,
    "src-tauri/Cargo.toml": cargoVersion,
    "src-tauri/Cargo.lock": cargoLockVersion,
    "src-tauri/tauri.conf.json": readJson("src-tauri/tauri.conf.json").version,
    "src-tauri/tauri-cli-build.conf.json": readJson("src-tauri/tauri-cli-build.conf.json").version,
  };
  for (const [file, declaredVersion] of Object.entries(declaredVersions)) {
    if (declaredVersion !== version) {
      throw new Error(
        `Release version mismatch: ${file} declares ${declaredVersion ?? "<missing>"}, expected ${version}`,
      );
    }
  }
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  if (context.ref !== "refs/heads/main") {
    throw new Error(`Release workflow must run from main, not ${context.ref}`);
  }
  /** @param {unknown} value @returns {value is string} */
  const isSha = value => typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value);
  if (!isSha(context.sha)) throw new Error('Invalid main release source commit.');
  const tagName = `v${version}`;
  /** @param {bigint[]} left @param {bigint[]} right */
  const compareVersions = (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return /** @type {bigint} */ (left[index]) > /** @type {bigint} */ (right[index]) ? 1 : -1;
    }
    return 0;
  };
  /** @param {() => Promise<{data: PolicyData | null | undefined}>} read */
  const notFound = async (read) => {
    try {
      const response = await read();
      if (!response || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
        throw new Error('Invalid GitHub release state response.');
      }
      return response.data;
    } catch (error) { if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return null; throw error; }
  };
  // Skip an existing release before scheduling any platform builds.
  let releaseExists = await notFound(() => github.rest.repos.getReleaseByTag({ owner, repo, tag: tagName })) !== null;
  if (!releaseExists) {
    let complete = false;
    for (let page = 1; page <= 10; page += 1) {
      const { data } = await github.rest.repos.listReleases({ owner, repo, per_page: 100, page });
      if (!Array.isArray(data) || data.length > 100 || data.some(release => !release || typeof release.tag_name !== 'string'
        || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean')) {
        throw new Error('Invalid release listing; publication stopped.');
      }
      // Drafts can be absent from the direct endpoint. They also
      // mean this run must skip, rather than build an unusable set.
      if (data.some(release => release.tag_name === tagName)) { releaseExists = true; break; }
      for (const release of data) {
        if (!release.draft && !release.prerelease) {
          const stable = parseVersion(release.tag_name);
          if (!stable) throw new Error('Cannot verify an existing published stable release version.');
          if (compareVersions(candidate, stable) <= 0) {
            throw new Error('A same or newer published stable release exists; publication stopped.');
          }
        }
      }
      if (data.length < 100) { complete = true; break; }
    }
    if (!releaseExists && !complete) throw new Error('Cannot establish release absence within the listing limit.');
  }
  if (!releaseExists) {
    const latest = await notFound(() => github.rest.repos.getLatestRelease({ owner, repo }));
    if (latest !== null) {
      const stable = parseVersion(latest.tag_name);
      if (!stable || latest.draft !== false || latest.prerelease !== false) {
        throw new Error('Cannot verify the latest stable release version.');
      }
      if (compareVersions(candidate, stable) <= 0) throw new Error('A same or newer stable release exists; publication stopped.');
    }
    const reference = await notFound(() => github.rest.git.getRef({ owner, repo, ref: `tags/${tagName}` }));
    if (reference !== null) {
      if (reference.ref !== `refs/tags/${tagName}`) throw new Error('Unexpected release tag reference.');
      let object = reference.object;
      const seen = new Set();
      let resolved = false;
      for (let depth = 0; depth < 5; depth += 1) {
        if (!object || !isSha(object.sha) || seen.has(object.sha)) {
          throw new Error('Invalid or cyclic release tag object.');
        }
        seen.add(object.sha);
        if (object.type === 'commit') {
          if (object.sha !== context.sha) throw new Error('The release tag does not point to the approved source.');
          resolved = true;
          break;
        }
        if (object.type !== 'tag') throw new Error('The release tag does not resolve to a commit.');
        object = /** @type {PolicyData} */ ((await github.rest.git.getTag({ owner, repo, tag_sha: object.sha })).data).object;
      }
      if (!resolved) throw new Error('Release tag nesting exceeds the verification limit.');
    }
  }
  core.setOutput("should_release", releaseExists ? "false" : "true");
  core.setOutput("tag_name", tagName);
  core.setOutput("target_sha", context.sha);
  core.setOutput("version", /** @type {string} */ (version));
  if (releaseExists) {
    core.info(`Release ${tagName} already exists; skipping duplicate publication.`);
  } else {
    core.info(`Release ${tagName} will be built from ${context.sha}.`);
  }
}

/** @param {Pick<PolicyOptions, "github" | "context" | "env">} options */
export async function recheckCI({ github, context, env }) {
  const run = (await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: Number(env.CI_RUN_ID) })).data;
  if (run.head_sha !== env.TARGET_SHA || run.head_branch !== 'main' || run.event !== 'push' || run.path !== '.github/workflows/ci.yml' || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('The exact main CI is no longer successful; publication stopped.');
  }
}

/** @param {PolicyOptions} options */
export async function recheckReleaseState({ github, context, core, env }) {
  const { owner, repo } = context.repo;
  const tag = env.TAG_NAME;
  const sha = env.TARGET_SHA;
  /** @param {unknown} value @returns {value is string} */
  const isSha = value => typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value);
  /** @param {unknown} value */
  const parseVersion = (value) => {
    if (typeof value !== 'string' || value.length > 256) return null;
    const match = /^v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(value);
    return match && match[0] === value ? /** @type {string} */ (match[1]).split('.').map(BigInt) : null;
  };
  const candidate = parseVersion(tag);
  if (!candidate || !isSha(sha)) {
    throw new Error('Invalid approved release tag or source commit.');
  }
  /** @param {bigint[]} left @param {bigint[]} right */
  const compareVersions = (left, right) => {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return /** @type {bigint} */ (left[index]) > /** @type {bigint} */ (right[index]) ? 1 : -1;
    }
    return 0;
  };
  /** @param {() => Promise<{data: PolicyData | null | undefined}>} read */
  const notFound = async (read) => {
    try {
      const response = await read();
      if (!response || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
        throw new Error('Invalid GitHub release state response.');
      }
      return response.data;
    } catch (error) { if (typeof error === "object" && error !== null && "status" in error && error.status === 404) return null; throw error; }
  };
  const existing = await notFound(() => github.rest.repos.getReleaseByTag({ owner, repo, tag }));
  if (existing !== null) throw new Error('The release already exists; preserve it instead of updating it.');
  // The direct endpoint may omit drafts. Establish complete absence
  // within a bounded listing and fail rather than assume beyond it.
  let complete = false;
  for (let page = 1; page <= 10; page += 1) {
    const { data } = await github.rest.repos.listReleases({ owner, repo, per_page: 100, page });
    if (!Array.isArray(data) || data.length > 100 || data.some(release => !release || typeof release.tag_name !== 'string'
      || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean')) {
      throw new Error('Invalid release listing; publication stopped.');
    }
    for (const release of data) {
      if (release.tag_name === tag) throw new Error('A matching draft or published release already exists; preserve it.');
      if (!release.draft && !release.prerelease) {
        const version = parseVersion(release.tag_name);
        if (!version) throw new Error('Cannot verify an existing published stable release version.');
        // An operator may have marked a newer stable release as
        // non-latest. This workflow must not promote an older one.
        if (compareVersions(candidate, version) <= 0) {
          throw new Error('A same or newer published stable release exists; publication stopped.');
        }
      }
    }
    if (data.length < 100) { complete = true; break; }
  }
  if (!complete) throw new Error('Cannot establish release absence within the listing limit.');
  const latest = await notFound(() => github.rest.repos.getLatestRelease({ owner, repo }));
  if (latest !== null) {
    const version = parseVersion(latest.tag_name);
    if (!version || latest.draft !== false || latest.prerelease !== false) {
      throw new Error('Cannot verify the latest stable release version.');
    }
    if (compareVersions(candidate, version) <= 0) throw new Error('A same or newer stable release now exists; publication stopped.');
  }
  const reference = await notFound(() => github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` }));
  if (reference !== null) {
    if (reference.ref !== `refs/tags/${tag}`) throw new Error('Unexpected release tag reference.');
    let object = reference.object;
    const seen = new Set();
    let resolved = false;
    for (let depth = 0; depth < 5; depth += 1) {
      if (!object || !isSha(object.sha) || seen.has(object.sha)) {
        throw new Error('Invalid or cyclic release tag object.');
      }
      seen.add(object.sha);
      if (object.type === 'commit') {
        if (object.sha !== sha) throw new Error('The release tag no longer points to the approved source.');
        resolved = true;
        break;
      }
      if (object.type !== 'tag') throw new Error('The release tag does not resolve to a commit.');
      // A missing nested object is an error, not an absent tag.
      object = /** @type {PolicyData} */ ((await github.rest.git.getTag({ owner, repo, tag_sha: object.sha })).data).object;
    }
    if (!resolved) throw new Error('Release tag nesting exceeds the verification limit.');
  }
  core.info(`Release and tag state permit publication of ${tag} from ${sha}.`);
}
