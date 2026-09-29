/** The base dictionary — every other locale falls back to this key by key,
 * so a partially-translated locale never breaks the app. Keep this in sync
 * with whatever's actually in the UI; it's the source of truth. */
export default {
  launcher: {
    title: "Burrow",
    subtitle: "연결을 선택하세요",
    online: "🌐 온라인",
    offline: "🌐 오프라인",
    offlineHint: "인터넷 연결이 없어 접속할 수 없습니다",
    localTerminal: "로컬 터미널",
    thisMac: "이 Mac",
    ssh: "SSH",
    connect: "접속",
    open: "열기",
    autoOpen: "자동 열기",
    autoOpenHint: "다음 실행부터 이 목록을 건너뛰고 바로 엽니다",
    newConnection: "＋ 새 연결",
    noProfiles: "등록된 SSH 프로필이 없습니다. 아래에서 새 연결을 등록하세요.",
  },
  language: {
    label: "언어",
    system: "시스템 설정 따르기",
    ko: "한국어",
    en: "English",
  },
} as const;
