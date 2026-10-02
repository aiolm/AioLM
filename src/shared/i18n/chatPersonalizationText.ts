import type { Locale } from "./i18nCatalog";

/**
 * Chat composer strings for local instructions and skills. Kept apart from
 * `chatI18n.ts` so the skill picker and its request errors can be localized
 * without growing the shared chat catalog.
 */
const en = {
  skills: "Skills",
  refreshSkills: "Refresh skills",
  loadingSkills: "Loading skills",
  searchSkills: "Search skills",
  skillsHint: "Selected skills apply to the next message. You can also type $skill-name; the model may read listed skills on its own.",
  noSkills: "No local skills found.",
  noSkillMatches: "No matching skills.",
  nativeOnly: "Local instructions and skills are available only in the desktop app.",
  selectedSkills: "Selected skills",
  removeSkill: "Remove skill",
  sourceAgents: "Agents",
  sourceAiolm: "AioLM",
  catalogFailed: "Could not load local skills: {error}",
  loadFailed: "Could not load local instructions and skills, so the message was not sent: {error}",
  unknownSkill: "Unknown skill: {names}. Pick one from Skills, or wrap literal text in backticks.",
  skillUnavailable: "A selected skill is no longer available: {names}. Refresh skills and try again.",
  skillReadFailed: "Could not read skill {name}: {error}",
  contextTooLarge: "Local instructions and skills need about {tokens} tokens, more than this model's {budget}-token context budget. Remove selected skills or shorten the instruction files.",
  skillReadLimit: "Skill read limit reached ({limit} reads per response).",
  skillTooLarge: "Skill {name} would bring this request to about {tokens} tokens, more than this model's {budget}-token context budget.",
  instructionWarnings: "Local instructions: {warnings}",
} as const;

export type ChatPersonalizationTextKey = keyof typeof en;
type Catalog = Record<ChatPersonalizationTextKey, string>;

const catalogs: Record<Locale, Catalog> = {
  en,
  ko: {
    skills: "스킬",
    refreshSkills: "스킬 새로 고침",
    loadingSkills: "스킬 불러오는 중",
    searchSkills: "스킬 검색",
    skillsHint: "선택한 스킬은 다음 메시지에 적용됩니다. $skill-name을 입력해도 되며, 모델이 목록의 스킬을 스스로 읽을 수도 있습니다.",
    noSkills: "로컬 스킬이 없습니다.",
    noSkillMatches: "일치하는 스킬이 없습니다.",
    nativeOnly: "로컬 지침과 스킬은 데스크톱 앱에서만 사용할 수 있습니다.",
    selectedSkills: "선택한 스킬",
    removeSkill: "스킬 제거",
    sourceAgents: "Agents",
    sourceAiolm: "AioLM",
    catalogFailed: "로컬 스킬을 불러오지 못했습니다: {error}",
    loadFailed: "로컬 지침과 스킬을 불러오지 못해 메시지를 보내지 않았습니다: {error}",
    unknownSkill: "알 수 없는 스킬: {names}. 스킬 목록에서 선택하거나 일반 텍스트는 백틱으로 감싸세요.",
    skillUnavailable: "선택한 스킬을 더 이상 사용할 수 없습니다: {names}. 스킬을 새로 고친 후 다시 시도하세요.",
    skillReadFailed: "스킬 {name}을(를) 읽지 못했습니다: {error}",
    contextTooLarge: "로컬 지침과 스킬에 약 {tokens} 토큰이 필요해 이 모델의 컨텍스트 예산 {budget} 토큰을 넘습니다. 선택한 스킬을 줄이거나 지침 파일을 줄이세요.",
    skillReadLimit: "스킬 읽기 한도에 도달했습니다 (응답당 {limit}회).",
    skillTooLarge: "스킬 {name}을(를) 더하면 요청이 약 {tokens} 토큰이 되어 이 모델의 컨텍스트 예산 {budget} 토큰을 넘습니다.",
    instructionWarnings: "로컬 지침: {warnings}",
  },
  ja: {
    skills: "スキル",
    refreshSkills: "スキルを再読み込み",
    loadingSkills: "スキルを読み込み中",
    searchSkills: "スキルを検索",
    skillsHint: "選択したスキルは次のメッセージに適用されます。$skill-name と入力することもでき、モデルが一覧のスキルを自分で読むこともあります。",
    noSkills: "ローカルスキルが見つかりません。",
    noSkillMatches: "一致するスキルはありません。",
    nativeOnly: "ローカルの指示とスキルはデスクトップアプリでのみ使用できます。",
    selectedSkills: "選択したスキル",
    removeSkill: "スキルを削除",
    sourceAgents: "Agents",
    sourceAiolm: "AioLM",
    catalogFailed: "ローカルスキルを読み込めませんでした: {error}",
    loadFailed: "ローカルの指示とスキルを読み込めなかったため、メッセージは送信されませんでした: {error}",
    unknownSkill: "不明なスキル: {names}。スキル一覧から選ぶか、通常のテキストはバッククォートで囲んでください。",
    skillUnavailable: "選択したスキルは利用できなくなりました: {names}。スキルを再読み込みしてもう一度お試しください。",
    skillReadFailed: "スキル {name} を読み込めませんでした: {error}",
    contextTooLarge: "ローカルの指示とスキルに約 {tokens} トークンが必要で、このモデルのコンテキスト予算 {budget} トークンを超えます。選択したスキルを減らすか、指示ファイルを短くしてください。",
    skillReadLimit: "スキルの読み込み上限に達しました（応答あたり {limit} 回）。",
    skillTooLarge: "スキル {name} を加えるとリクエストが約 {tokens} トークンになり、このモデルのコンテキスト予算 {budget} トークンを超えます。",
    instructionWarnings: "ローカルの指示: {warnings}",
  },
  zh: {
    skills: "技能",
    refreshSkills: "刷新技能",
    loadingSkills: "正在加载技能",
    searchSkills: "搜索技能",
    skillsHint: "所选技能将应用于下一条消息。也可以输入 $skill-name；模型也可能自行读取列表中的技能。",
    noSkills: "未找到本地技能。",
    noSkillMatches: "没有匹配的技能。",
    nativeOnly: "本地说明和技能仅在桌面应用中可用。",
    selectedSkills: "已选技能",
    removeSkill: "移除技能",
    sourceAgents: "Agents",
    sourceAiolm: "AioLM",
    catalogFailed: "无法加载本地技能：{error}",
    loadFailed: "无法加载本地说明和技能，消息未发送：{error}",
    unknownSkill: "未知技能：{names}。请从技能列表中选择，或用反引号包裹普通文本。",
    skillUnavailable: "所选技能已不可用：{names}。请刷新技能后重试。",
    skillReadFailed: "无法读取技能 {name}：{error}",
    contextTooLarge: "本地说明和技能大约需要 {tokens} 个令牌，超过此模型 {budget} 个令牌的上下文预算。请减少所选技能或缩短说明文件。",
    skillReadLimit: "已达到技能读取上限（每次响应 {limit} 次）。",
    skillTooLarge: "加入技能 {name} 后请求约为 {tokens} 个令牌，超过此模型 {budget} 个令牌的上下文预算。",
    instructionWarnings: "本地说明：{warnings}",
  },
};

export function chatPersonalizationText(locale: Locale, key: ChatPersonalizationTextKey, vars: Record<string, string | number> = {}): string {
  return (catalogs[locale] ?? en)[key].replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
}
