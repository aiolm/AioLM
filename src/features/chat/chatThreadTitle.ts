// Keep the stored generated title stable so draft reuse and first-message
// naming continue to work when the interface language changes.
export function isGeneratedChatTitle(title: string | undefined): boolean {
  return !title || title === 'New conversation';
}

export function displayChatTitle(title: string | undefined, fallback: string): string {
  return isGeneratedChatTitle(title) ? fallback : title ?? fallback;
}
