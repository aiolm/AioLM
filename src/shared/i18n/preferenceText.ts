import type { Locale } from "./i18nCatalog";

/** Copy for the typography and notification preferences in Settings. */
export interface PreferenceCopy {
  appFont: string; appFontDesc: string;
  codeFont: string; codeFontDesc: string;
  fontDefault: string; fontSystem: string; fontSerif: string; codeFontDefault: string; codeFontSystem: string;
  fontPreview: string; fontPreviewText: string;
  lineSpacing: string; lineSpacingDesc: string;
  lineSpacingCompact: string; lineSpacingNormal: string; lineSpacingRelaxed: string;
  lineSpacingPreview: string; lineSpacingPreviewText: string;
  notifications: string;
  permission: string; permissionDesc: string;
  statusChecking: string; statusGranted: string; statusDenied: string; statusDefault: string; statusUnavailable: string;
  allow: string; checkAgain: string; sendTest: string;
  deniedHelp: string; unavailableHelp: string; windowsHelp: string;
  testSent: string; testNotAllowed: string; testFailed: string; requestFailed: string;
  chatCategory: string; chatCategoryDesc: string;
  downloadsCategory: string; downloadsCategoryDesc: string;
  benchmarkCategory: string; benchmarkCategoryDesc: string;
  resetNotifications: string;
}

export const preferenceText: Record<Locale, PreferenceCopy> = {
  en: {
    appFont: "App font", appFontDesc: "Typeface for interface text and chat.",
    codeFont: "Code font", codeFontDesc: "Typeface for code in chat answers and technical values.",
    fontDefault: "AioLM default", fontSystem: "System sans-serif", fontSerif: "Serif", codeFontDefault: "AioLM default", codeFontSystem: "System monospace",
    fontPreview: "Font preview", fontPreviewText: "The quick brown fox jumps over the lazy dog. 0123456789",
    lineSpacing: "Chat line spacing", lineSpacingDesc: "Space between lines in messages and reasoning. Code keeps its layout.",
    lineSpacingCompact: "Compact", lineSpacingNormal: "Normal", lineSpacingRelaxed: "Relaxed",
    lineSpacingPreview: "Line spacing preview", lineSpacingPreviewText: "Local models answer here. Longer replies wrap across several lines, so the spacing between them decides how dense a conversation reads.",
    notifications: "Notifications",
    permission: "System notifications", permissionDesc: "AioLM asks for permission only when you choose to allow notifications. Whether alerts appear is managed in your system notification settings.",
    statusChecking: "Checking…", statusGranted: "Allowed", statusDenied: "Blocked", statusDefault: "Not allowed yet", statusUnavailable: "Unavailable",
    allow: "Allow notifications", checkAgain: "Check again", sendTest: "Send test notification",
    deniedHelp: "Notifications are blocked for AioLM. Allow them in your system notification settings, then check again.",
    unavailableHelp: "System notifications work in the AioLM desktop app. Your choices below are saved and apply there.",
    windowsHelp: "On Windows, alerts appear only from the installed app.",
    testSent: "Test notification sent. If no alert appears, check your system notification settings.",
    testNotAllowed: "Notifications are not allowed, so nothing was sent.",
    testFailed: "The test notification could not be sent.",
    requestFailed: "Notification permission could not be requested.",
    chatCategory: "Chat responses", chatCategoryDesc: "Notify when a chat response finishes.",
    downloadsCategory: "Downloads", downloadsCategoryDesc: "Notify when a model download or runtime installation completes.",
    benchmarkCategory: "Benchmarks", benchmarkCategoryDesc: "Notify when a benchmark run finishes.",
    resetNotifications: "Reset notifications",
  },
  ko: {
    appFont: "앱 글꼴", appFontDesc: "인터페이스와 채팅에 쓰는 글꼴입니다.",
    codeFont: "코드 글꼴", codeFontDesc: "채팅 답변의 코드와 기술 값에 쓰는 글꼴입니다.",
    fontDefault: "AioLM 기본", fontSystem: "시스템 산세리프", fontSerif: "세리프", codeFontDefault: "AioLM 기본", codeFontSystem: "시스템 고정폭",
    fontPreview: "글꼴 미리보기", fontPreviewText: "다람쥐 헌 쳇바퀴에 타고파. The quick brown fox 0123456789",
    lineSpacing: "채팅 줄 간격", lineSpacingDesc: "메시지와 추론 과정의 줄 사이 간격입니다. 코드는 원래 배치를 유지합니다.",
    lineSpacingCompact: "좁게", lineSpacingNormal: "보통", lineSpacingRelaxed: "넓게",
    lineSpacingPreview: "줄 간격 미리보기", lineSpacingPreviewText: "로컬 모델의 답변이 여기에 표시됩니다. 긴 답변은 여러 줄로 이어지므로 줄 간격에 따라 대화가 읽히는 밀도가 달라집니다.",
    notifications: "알림",
    permission: "시스템 알림", permissionDesc: "알림 허용을 직접 선택할 때만 AioLM이 권한을 요청합니다. 알림 표시 여부는 시스템 알림 설정에서 관리됩니다.",
    statusChecking: "확인 중…", statusGranted: "허용됨", statusDenied: "차단됨", statusDefault: "아직 허용 안 됨", statusUnavailable: "사용할 수 없음",
    allow: "알림 허용", checkAgain: "다시 확인", sendTest: "테스트 알림 보내기",
    deniedHelp: "AioLM 알림이 차단되어 있습니다. 시스템 알림 설정에서 허용한 뒤 다시 확인하세요.",
    unavailableHelp: "시스템 알림은 AioLM 데스크톱 앱에서 동작합니다. 아래 선택은 저장되어 앱에서 적용됩니다.",
    windowsHelp: "Windows에서는 설치된 앱에서만 알림이 표시됩니다.",
    testSent: "테스트 알림을 보냈습니다. 알림이 보이지 않으면 시스템 알림 설정을 확인하세요.",
    testNotAllowed: "알림이 허용되지 않아 보내지 않았습니다.",
    testFailed: "테스트 알림을 보내지 못했습니다.",
    requestFailed: "알림 권한을 요청하지 못했습니다.",
    chatCategory: "채팅 응답", chatCategoryDesc: "채팅 응답이 끝나면 알립니다.",
    downloadsCategory: "다운로드", downloadsCategoryDesc: "모델 다운로드나 런타임 설치가 완료되면 알립니다.",
    benchmarkCategory: "벤치마크", benchmarkCategoryDesc: "벤치마크 실행이 끝나면 알립니다.",
    resetNotifications: "알림 초기화",
  },
  ja: {
    appFont: "アプリのフォント", appFontDesc: "インターフェースとチャットに使う書体です。",
    codeFont: "コードのフォント", codeFontDesc: "チャット回答のコードや技術的な値に使う書体です。",
    fontDefault: "AioLM 標準", fontSystem: "システムのゴシック体", fontSerif: "明朝・セリフ体", codeFontDefault: "AioLM 標準", codeFontSystem: "システムの等幅",
    fontPreview: "フォントのプレビュー", fontPreviewText: "いろはにほへと ちりぬるを。The quick brown fox 0123456789",
    lineSpacing: "チャットの行間", lineSpacingDesc: "メッセージと推論の行の間隔です。コードは元のレイアウトを保ちます。",
    lineSpacingCompact: "狭い", lineSpacingNormal: "標準", lineSpacingRelaxed: "広い",
    lineSpacingPreview: "行間のプレビュー", lineSpacingPreviewText: "ローカルモデルの回答はここに表示されます。長い回答は複数行にわたるため、行間によって会話の読みやすさが変わります。",
    notifications: "通知",
    permission: "システム通知", permissionDesc: "通知を許可すると選んだときだけ、AioLMは権限を求めます。通知を表示するかどうかは、システムの通知設定で管理されます。",
    statusChecking: "確認中…", statusGranted: "許可済み", statusDenied: "ブロック中", statusDefault: "未許可", statusUnavailable: "利用不可",
    allow: "通知を許可", checkAgain: "再確認", sendTest: "テスト通知を送信",
    deniedHelp: "AioLMの通知はブロックされています。システムの通知設定で許可してから、再確認してください。",
    unavailableHelp: "システム通知はAioLMデスクトップアプリで動作します。以下の選択は保存され、アプリで適用されます。",
    windowsHelp: "Windowsでは、インストールしたアプリからのみ通知が表示されます。",
    testSent: "テスト通知を送信しました。通知が表示されない場合は、システムの通知設定を確認してください。",
    testNotAllowed: "通知が許可されていないため、送信しませんでした。",
    testFailed: "テスト通知を送信できませんでした。",
    requestFailed: "通知の権限を要求できませんでした。",
    chatCategory: "チャットの応答", chatCategoryDesc: "チャットの応答が完了したら通知します。",
    downloadsCategory: "ダウンロード", downloadsCategoryDesc: "モデルのダウンロードやランタイムのインストールが完了したら通知します。",
    benchmarkCategory: "ベンチマーク", benchmarkCategoryDesc: "ベンチマークの実行が完了したら通知します。",
    resetNotifications: "通知をリセット",
  },
  zh: {
    appFont: "应用字体", appFontDesc: "界面文字和聊天使用的字体。",
    codeFont: "代码字体", codeFontDesc: "聊天回答中的代码和技术数值使用的字体。",
    fontDefault: "AioLM 默认", fontSystem: "系统无衬线", fontSerif: "衬线", codeFontDefault: "AioLM 默认", codeFontSystem: "系统等宽",
    fontPreview: "字体预览", fontPreviewText: "本地模型的回答显示在这里。The quick brown fox 0123456789",
    lineSpacing: "聊天行距", lineSpacingDesc: "消息和推理过程的行间距。代码保持原有排版。",
    lineSpacingCompact: "紧凑", lineSpacingNormal: "标准", lineSpacingRelaxed: "宽松",
    lineSpacingPreview: "行距预览", lineSpacingPreviewText: "本地模型的回答显示在这里。较长的回答会跨越多行，行距决定了对话读起来的疏密。",
    notifications: "通知",
    permission: "系统通知", permissionDesc: "只有在你选择允许通知时，AioLM 才会请求权限。是否显示通知由系统通知设置管理。",
    statusChecking: "正在检查…", statusGranted: "已允许", statusDenied: "已阻止", statusDefault: "尚未允许", statusUnavailable: "不可用",
    allow: "允许通知", checkAgain: "重新检查", sendTest: "发送测试通知",
    deniedHelp: "AioLM 的通知已被阻止。请在系统通知设置中允许后重新检查。",
    unavailableHelp: "系统通知在 AioLM 桌面应用中可用。下面的选择会被保存，并在应用中生效。",
    windowsHelp: "在 Windows 上，只有已安装的应用才会显示通知。",
    testSent: "测试通知已发送。如果没有看到通知，请检查系统通知设置。",
    testNotAllowed: "通知未被允许，因此没有发送。",
    testFailed: "无法发送测试通知。",
    requestFailed: "无法请求通知权限。",
    chatCategory: "聊天回复", chatCategoryDesc: "聊天回复完成时通知。",
    downloadsCategory: "下载", downloadsCategoryDesc: "模型下载或运行时安装完成时通知。",
    benchmarkCategory: "基准测试", benchmarkCategoryDesc: "基准测试运行完成时通知。",
    resetNotifications: "重置通知",
  },
};
