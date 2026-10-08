import type { Locale } from "../../shared/i18n/i18nCatalog";

export const projectChatBindingCopy: Record<Locale, {
  loading: string; retry: string; failed: string; capacity: string; changed: string; projectReadFailed: string;
}> = {
  en: {
    loading: "Loading project documents…", retry: "Retry project documents",
    failed: "Could not read project documents: {documents}. Check these files and retry before sending.",
    capacity: "Project documents need attachment space: {documents}. A message supports four documents. Remove other attachments and retry.",
    changed: "Attachments changed while project documents were loading. Review them and retry loading before sending.",
    projectReadFailed: "Could not read the active project. Retry before sending.",
  },
  ko: {
    loading: "프로젝트 문서를 불러오는 중…", retry: "프로젝트 문서 다시 불러오기",
    failed: "프로젝트 문서를 읽지 못했습니다: {documents}. 파일을 확인하고 다시 불러온 뒤 전송하세요.",
    capacity: "프로젝트 문서를 첨부할 공간이 필요합니다: {documents}. 메시지에는 문서 4개까지 첨부할 수 있습니다. 다른 첨부를 제거하고 다시 불러오세요.",
    changed: "프로젝트 문서를 불러오는 동안 첨부가 변경되었습니다. 첨부를 확인하고 다시 불러온 뒤 전송하세요.",
    projectReadFailed: "활성 프로젝트를 읽지 못했습니다. 다시 불러온 뒤 전송하세요.",
  },
  ja: {
    loading: "プロジェクト文書を読み込み中…", retry: "プロジェクト文書を再読み込み",
    failed: "プロジェクト文書を読めませんでした: {documents}。ファイルを確認し、再読み込みしてから送信してください。",
    capacity: "プロジェクト文書の添付スペースが必要です: {documents}。1件のメッセージに文書を4件まで添付できます。他の添付を削除して再読み込みしてください。",
    changed: "プロジェクト文書の読み込み中に添付が変更されました。添付を確認し、再読み込みしてから送信してください。",
    projectReadFailed: "有効なプロジェクトを読めませんでした。再読み込みしてから送信してください。",
  },
  zh: {
    loading: "正在加载项目文档…", retry: "重新加载项目文档",
    failed: "无法读取项目文档：{documents}。请检查文件，重新加载后再发送。",
    capacity: "项目文档需要附件空间：{documents}。每条消息最多支持四个文档。请移除其他附件并重新加载。",
    changed: "加载项目文档期间附件发生了变化。请检查附件，重新加载后再发送。",
    projectReadFailed: "无法读取当前项目。请重新加载后再发送。",
  },
};

export function projectDocumentBindingError(locale: Locale, kind: "failed" | "capacity", names: string[]): string {
  return projectChatBindingCopy[locale][kind].replace("{documents}", names.join(", "));
}
