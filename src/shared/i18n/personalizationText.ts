import type { Locale } from "./i18nCatalog";

/**
 * Copy for the global AGENTS.md instructions and skills. Settings owns the
 * editor keys; chat reuses the shared title, source and skills names so both
 * surfaces describe the same files the same way.
 */
export interface PersonalizationCopy {
  /** Shared names. */
  title: string;
  skills: string;
  sourceAgents: string;
  sourceAiolm: string;
  /** Settings editor. */
  intro: string;
  skillsNote: string;
  source: string;
  sourceDesc: string;
  path: string;
  editor: string;
  editorHelp: string;
  loading: string;
  missing: string;
  unsaved: string;
  saved: string;
  save: string;
  saving: string;
  reload: string;
  savedNotice: string;
  loadFailed: string;
  saveFailed: string;
  conflict: string;
  reloadConfirmTitle: string;
  reloadConfirmBody: string;
  reloadConfirmAction: string;
  unavailableTitle: string;
  unavailable: string;
  /** Extra words the settings search matches besides the visible copy. */
  searchTerms: string;
}

const files = "AGENTS.md agents aiolm skills SKILL.md";

export const personalizationText: Record<Locale, PersonalizationCopy> = {
  en: {
    title: "Personalization",
    skills: "Skills",
    sourceAgents: "Shared agents file",
    sourceAiolm: "AioLM file",
    intro: "AioLM adds your global instructions to chat: ~/.agents/AGENTS.md first, then ~/.aiolm/AGENTS.md. Saved changes apply from the next turn you send in chat.",
    skillsNote: "Skills are found in the skills folder under both locations. When both have a skill with the same name, the one under ~/.aiolm is used.",
    source: "Instructions file",
    sourceDesc: "Each file keeps its own unsaved draft while you switch between them.",
    path: "Location",
    editor: "Instructions",
    editorHelp: "Plain text or Markdown. Nothing is written until you choose Save.",
    loading: "Loading the file…",
    missing: "This file does not exist yet. Saving creates it.",
    unsaved: "Unsaved changes",
    saved: "Saved",
    save: "Save",
    saving: "Saving…",
    reload: "Reload",
    savedNotice: "Saved. The next chat turn uses these instructions.",
    loadFailed: "The file could not be read.",
    saveFailed: "The file could not be saved. Your draft is kept.",
    conflict: "The file was changed outside AioLM after it was loaded, so it was not overwritten. Your draft is kept; reload to see the current file.",
    reloadConfirmTitle: "Discard unsaved changes?",
    reloadConfirmBody: "Reloading replaces your draft with the file as it is now. Your unsaved changes are lost.",
    reloadConfirmAction: "Discard and reload",
    unavailableTitle: "Available in the desktop app",
    unavailable: "Editing instruction files needs the AioLM desktop app. The browser preview cannot read or write files on this computer.",
    searchTerms: `${files} instructions prompt custom personal`,
  },
  ko: {
    title: "개인 맞춤 설정",
    skills: "스킬",
    sourceAgents: "공용 에이전트 파일",
    sourceAiolm: "AioLM 파일",
    intro: "AioLM은 채팅에 전역 지침을 추가합니다. ~/.agents/AGENTS.md를 먼저, 그다음 ~/.aiolm/AGENTS.md를 적용합니다. 저장한 변경 사항은 채팅에서 다음에 보내는 턴부터 적용됩니다.",
    skillsNote: "스킬은 두 위치의 skills 폴더에서 찾습니다. 같은 이름의 스킬이 양쪽에 있으면 ~/.aiolm의 스킬을 사용합니다.",
    source: "지침 파일",
    sourceDesc: "파일을 전환해도 각 파일의 저장하지 않은 초안은 그대로 유지됩니다.",
    path: "위치",
    editor: "지침",
    editorHelp: "일반 텍스트나 Markdown으로 작성합니다. 저장을 누르기 전에는 파일에 쓰지 않습니다.",
    loading: "파일을 불러오는 중…",
    missing: "아직 파일이 없습니다. 저장하면 새로 만듭니다.",
    unsaved: "저장하지 않은 변경 사항",
    saved: "저장됨",
    save: "저장",
    saving: "저장 중…",
    reload: "다시 불러오기",
    savedNotice: "저장했습니다. 다음 채팅 턴부터 이 지침을 사용합니다.",
    loadFailed: "파일을 읽지 못했습니다.",
    saveFailed: "파일을 저장하지 못했습니다. 작성한 초안은 유지됩니다.",
    conflict: "불러온 뒤 AioLM 밖에서 파일이 변경되어 덮어쓰지 않았습니다. 작성한 초안은 유지됩니다. 현재 파일을 보려면 다시 불러오세요.",
    reloadConfirmTitle: "저장하지 않은 변경 사항을 버릴까요?",
    reloadConfirmBody: "다시 불러오면 초안이 현재 파일 내용으로 바뀌고 저장하지 않은 변경 사항은 사라집니다.",
    reloadConfirmAction: "버리고 다시 불러오기",
    unavailableTitle: "데스크톱 앱에서 사용할 수 있습니다",
    unavailable: "지침 파일 편집은 AioLM 데스크톱 앱이 필요합니다. 브라우저 미리보기에서는 이 컴퓨터의 파일을 읽거나 쓸 수 없습니다.",
    searchTerms: `${files} 지침 프롬프트 개인 맞춤 사용자 지정`,
  },
  ja: {
    title: "パーソナライズ",
    skills: "スキル",
    sourceAgents: "共通エージェントファイル",
    sourceAiolm: "AioLMファイル",
    intro: "AioLMはチャットにグローバル指示を追加します。~/.agents/AGENTS.mdを先に、次に~/.aiolm/AGENTS.mdを適用します。保存した変更はチャットで次に送信するターンから反映されます。",
    skillsNote: "スキルは両方の場所のskillsフォルダーから探します。同じ名前のスキルが両方にある場合は~/.aiolmのものを使います。",
    source: "指示ファイル",
    sourceDesc: "ファイルを切り替えても、各ファイルの未保存の下書きは保持されます。",
    path: "場所",
    editor: "指示",
    editorHelp: "プレーンテキストまたはMarkdownで記述します。保存を選ぶまでファイルには書き込みません。",
    loading: "ファイルを読み込み中…",
    missing: "このファイルはまだありません。保存すると作成されます。",
    unsaved: "未保存の変更",
    saved: "保存済み",
    save: "保存",
    saving: "保存中…",
    reload: "再読み込み",
    savedNotice: "保存しました。次のチャットターンからこの指示を使います。",
    loadFailed: "ファイルを読み込めませんでした。",
    saveFailed: "ファイルを保存できませんでした。下書きは保持されています。",
    conflict: "読み込み後にAioLMの外でファイルが変更されたため、上書きしませんでした。下書きは保持されています。現在のファイルを見るには再読み込みしてください。",
    reloadConfirmTitle: "未保存の変更を破棄しますか？",
    reloadConfirmBody: "再読み込みすると下書きが現在のファイル内容に置き換わり、未保存の変更は失われます。",
    reloadConfirmAction: "破棄して再読み込み",
    unavailableTitle: "デスクトップアプリで利用できます",
    unavailable: "指示ファイルの編集にはAioLMデスクトップアプリが必要です。ブラウザープレビューではこのコンピューターのファイルを読み書きできません。",
    searchTerms: `${files} 指示 プロンプト カスタム 個人`,
  },
  zh: {
    title: "个性化",
    skills: "技能",
    sourceAgents: "共享代理文件",
    sourceAiolm: "AioLM 文件",
    intro: "AioLM 会把全局指令加入聊天：先应用 ~/.agents/AGENTS.md，再应用 ~/.aiolm/AGENTS.md。保存的更改从你在聊天中发送的下一轮开始生效。",
    skillsNote: "技能会在两个位置下的 skills 文件夹中查找。两处有同名技能时，使用 ~/.aiolm 下的技能。",
    source: "指令文件",
    sourceDesc: "在文件之间切换时，每个文件未保存的草稿都会保留。",
    path: "位置",
    editor: "指令",
    editorHelp: "使用纯文本或 Markdown。选择保存之前不会写入文件。",
    loading: "正在读取文件…",
    missing: "此文件尚不存在。保存时会创建。",
    unsaved: "未保存的更改",
    saved: "已保存",
    save: "保存",
    saving: "正在保存…",
    reload: "重新加载",
    savedNotice: "已保存。下一轮聊天将使用这些指令。",
    loadFailed: "无法读取文件。",
    saveFailed: "无法保存文件。草稿已保留。",
    conflict: "文件在加载后被 AioLM 之外的程序修改，因此没有覆盖。草稿已保留；重新加载可查看当前文件。",
    reloadConfirmTitle: "放弃未保存的更改？",
    reloadConfirmBody: "重新加载会用当前文件内容替换草稿，未保存的更改将丢失。",
    reloadConfirmAction: "放弃并重新加载",
    unavailableTitle: "可在桌面应用中使用",
    unavailable: "编辑指令文件需要 AioLM 桌面应用。浏览器预览无法读取或写入此电脑上的文件。",
    searchTerms: `${files} 指令 提示词 自定义 个人`,
  },
};
