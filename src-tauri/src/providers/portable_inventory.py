"""Exact installed engine dependency closure, including active extras/markers."""
import importlib.metadata as metadata
import json
import re
import sys
try:
    from packaging.requirements import Requirement
    from packaging.markers import default_environment
except ImportError:
    from pip._vendor.packaging.requirements import Requirement
    from pip._vendor.packaging.markers import default_environment

normalize = lambda name: re.sub(r"[-_.]+", "-", name).lower()
installed = {normalize(dist.metadata["Name"]): dist for dist in metadata.distributions() if dist.metadata.get("Name")}
engine = sys.argv[1]
roots = [(engine, set())]
if engine == "vllm" and "vllm-metal" in installed:
    roots.append(("vllm-metal", {"gguf", "stt"}))
seen = {}
queue = roots[:]
while queue:
    name, extras = queue.pop()
    name = normalize(name)
    if name not in installed:
        raise RuntimeError("installed engine dependency is missing: " + name)
    previous = seen.get(name)
    if previous is not None and extras <= previous:
        continue
    extras = extras | (previous or set())
    seen[name] = extras
    for raw in installed[name].requires or []:
        requirement = Requirement(raw)
        environments = [{**default_environment(), "extra": extra} for extra in extras | {""}]
        if requirement.marker and not any(requirement.marker.evaluate(env) for env in environments):
            continue
        dependency = normalize(requirement.name)
        if dependency not in installed:
            raise RuntimeError("installed engine dependency is missing: " + dependency)
        if requirement.specifier and not requirement.specifier.contains(installed[dependency].version, prereleases=True):
            raise RuntimeError("installed engine dependency has an incompatible version: " + dependency)
        queue.append((dependency, set(requirement.extras)))
result = []
for name in sorted(seen):
    dist = installed[name]
    result.append({"name": name, "version": dist.version, "direct_url": dist.read_text("direct_url.json"),
                   "portable_commit": portable_source_commit(dist) if name == 'mlx-lm' else ''})
print("AIOLM_FREEZE=" + json.dumps(result))
