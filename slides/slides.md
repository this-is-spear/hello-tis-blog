---
theme: default
title: 첫 오픈소스 기여부터 메인테이너까지
colorSchema: light
fonts:
  sans: Pretendard, Noto Sans KR
mdc: true
---

<div class="h-full flex flex-col justify-center">

<div class="text-sm tracking-widest text-blue-600 font-semibold mb-6">DND 개발자 세미나</div>

# 오타 수정에서 시작해<br>기능 머지까지

<div class="mt-12 text-neutral-600 leading-relaxed text-lg">
오늘 답할 질문 — 어디서 <b>찾나</b> · 어떻게 <b>기여하나</b> · 이력서에 어떻게 <b>쓰나</b>
</div>

</div>

<!--
안녕하세요, 이건창입니다. 제 첫 머지는 오타 수정이었습니다. 3개월 뒤에는 기능을 머지했고요.
오늘은 세 가지 질문에 그 3개월로 답하겠습니다. 어디서 찾는지, 어떻게 기여하는지, 이력서에 어떻게 쓰는지.
-->

---
layout: intro
class: bg-blue-600 text-white
---

<div class="text-sm tracking-widest opacity-70 mb-4">1부</div>

# 오픈소스 찾는 방법

<!--
저도 처음엔 어디서부터 시작할지 몰랐습니다. (실제 상황 맞는지 확인)
-->

---

# good first issue부터 찾기

<img src="/images/goodfirstissue-dev.png" class="mt-6 rounded-lg border border-neutral-200 shadow-sm max-h-75 mx-auto" alt="goodfirstissue.dev 화면" />

<div class="mt-6 text-lg text-neutral-600">
<a href="https://goodfirstissue.dev" class="text-blue-600 font-semibold">goodfirstissue.dev</a> — 언어·프로젝트별로 모아 보여준다. 여기서 시작했다.
</div>

<!--
good first issue는 메인테이너가 "입문자가 해도 된다"고 미리 골라 둔 이슈입니다.
goodfirstissue.dev에 언어별로 모여 있고, 저는 여기서 시작했습니다.
팁 하나 — 아무 저장소나 주소 뒤에 /contribute를 붙이면 그 저장소의 목록이 나옵니다.
-->

---
layout: intro
class: bg-blue-600 text-white
---

<div class="text-sm tracking-widest opacity-70 mb-4">2부</div>

# 오픈소스 기여 방법

<div class="mt-4 opacity-80">fixture-monkey에서 보낸 3개월</div>

<!--
찾았으면 다음은 어떻게 기여하느냐입니다. fixture-monkey에서 보낸 3개월을 순서대로 보여드리겠습니다.
-->

---

# 오타에서 기능까지 3개월

<img src="/images/fixture-monkey-contributions.png" class="mt-4 rounded-lg border border-neutral-200 shadow-sm max-h-90 mx-auto" alt="naver/fixture-monkey 기여 11건 목록" />

<!--
3개월 동안 올린 기여를 한 화면에 모은 겁니다. 전부 Approved로 닫혔고,
아래가 1월 오타 수정, 위가 4월 체인지로그입니다.
이제 이 목록을 단계별로 하나씩 보겠습니다.
-->

---

# 첫 PR은 오타부터

<div class="mt-10 space-y-4">
  <div class="border border-neutral-200 rounded-lg p-5 flex items-center justify-between">
    <div><b>Fix typo in docs</b><div class="text-sm text-neutral-500 mt-1">#897 · Jan 23, 2024</div></div>
    <div class="text-green-600 text-sm font-semibold">✓ Approved</div>
  </div>
  <div class="border border-neutral-200 rounded-lg p-5 flex items-center justify-between">
    <div><b>Fix document code indent</b><div class="text-sm text-neutral-500 mt-1">#895 · Jan 22, 2024</div></div>
    <div class="text-green-600 text-sm font-semibold">✓ Approved</div>
  </div>
</div>

<div class="mt-10 text-lg text-neutral-600">
작으니까 금방 머지됐고, 그 덕에 다음 기여로 넘어갈 수 있었다
</div>

<!--
첫 PR은 문서 오타를 고친 겁니다. 작으니까 금방 머지됐고, 그 덕에 다음으로 넘어갈 수 있었습니다.
-->

---

# 번역으로 기여

<div class="mt-8 grid grid-cols-2 gap-3 text-sm">
  <div class="border border-neutral-200 rounded-lg p-4"><b>fixture-monkey page</b> 번역 추가<div class="text-neutral-500 mt-1">#878 · Jan 17</div></div>
  <div class="border border-neutral-200 rounded-lg p-4"><b>generating-complex-types page</b> 번역 추가<div class="text-neutral-500 mt-1">#894 · Jan 22</div></div>
  <div class="border border-neutral-200 rounded-lg p-4"><b>instantiate-methods page</b> 번역 추가<div class="text-neutral-500 mt-1">#901 · Jan 29</div></div>
  <div class="border border-neutral-200 rounded-lg p-4"><b>introspector page</b> 번역 추가<div class="text-neutral-500 mt-1">#904 · Jan 29</div></div>
</div>

<div class="mt-8 text-lg text-neutral-600">
2주 동안 PR 6개로 한국어 문서 4페이지를 번역해 추가했다
</div>

<!--
코드가 아니어도 기여입니다.
-->

---

# 이슈 생성 후 구현

<div class="mt-8 border border-neutral-200 rounded-xl p-6 bg-neutral-50 space-y-5">
  <div>
    <div class="text-sm text-neutral-400 mb-1">this-is-spear · issue #962</div>
    <div>Kotlin <code>Duration</code> 필드에 <code>Long</code>을 넣어야 해서 불편합니다.<br>Duration을 그대로 넣게 바꾸면 어떨까요? <b>PR도 제가 만들겠습니다.</b></div>
  </div>
  <div>
    <div class="text-sm text-neutral-400 mb-1">maintainer</div>
    <div class="text-blue-600 font-semibold">"Sounds great. Could you make a PR for it?"</div>
  </div>
</div>

<div class="mt-8 text-lg text-neutral-600">
발견한 문제를 이슈로 제안하고, 직접 구현해 <b class="text-blue-600">#929</b>로 머지했다
</div>

<!--
남이 골라 둔 이슈에서 시작했지만, 이 단계에서는 직접 발견한 문제로 이슈를 만들었습니다.
Duration 필드에 Long을 넣어야 해서 불편했거든요. PR도 제가 만들겠다고 했고,
메인테이너가 바로 좋다고 답했습니다. 방향을 합의한 뒤에 구현해서 #929로 머지됐습니다.
(TODO: 실제 이슈 캡처로 교체)
-->

---

# 기능 머지 이후의 기여

<div class="mt-8 space-y-3 text-base">
  <div class="border border-blue-200 bg-blue-50 rounded-lg p-4"><b>Support generating kotlin.time.Duration</b> <span class="text-sm text-neutral-500">#929 · 기능 머지 · 1.0.16</span></div>
  <div class="border border-neutral-200 rounded-lg p-4">value class 버그 수정 <span class="text-sm text-neutral-500">#967 · 1.0.17</span></div>
  <div class="border border-neutral-200 rounded-lg p-4">deprecated 코드 제거 <span class="text-sm text-neutral-500">#968</span></div>
  <div class="border border-neutral-200 rounded-lg p-4">릴리스 체인지로그 정리 <span class="text-sm text-neutral-500">#975</span></div>
</div>

<!--
시켜서 한 일이 아니라, 쓰다가 눈에 띈 것들을 직접 찾아서 했습니다.
-->

---

# 기여하면서 배운 것

<div class="mt-10 grid grid-cols-2 gap-6">
  <div class="border border-neutral-200 rounded-xl p-6">
    <div class="text-blue-600 font-bold mb-4">기능을 구현하면서 <span class="text-sm text-neutral-400 font-normal">#929</span></div>
    <div class="space-y-2 text-neutral-700">
      <div>TDD로 어려운 문제를 단계적으로 해결하는 방법</div>
      <div>스택트레이스로 원인을 찾는 방법</div>
    </div>
  </div>
  <div class="border border-neutral-200 rounded-xl p-6">
    <div class="text-blue-600 font-bold mb-4">유지 작업을 하면서 <span class="text-sm text-neutral-400 font-normal">#967 #968 #975</span></div>
    <div class="space-y-2 text-neutral-700">
      <div>오래 유지되는 코드를 관리하는 방법</div>
      <div>사이드 이펙트를 줄이는 방법</div>
    </div>
  </div>
</div>

<!--
구현할 때는 실패하는 테스트부터 만들었습니다. 원하는 로직을 테스트로 적어 두면 처음엔 실패하는데,
에러 스택트레이스를 따라가면서 고칠 위치를 찾았습니다.
유지 작업을 하면서는 메인테이너가 오래 유지되는 코드를 어떻게 관리하는지,
사이드 이펙트를 어떻게 줄이는지를 배웠습니다.
-->

---

# 기여한 순서

<div class="mt-24 flex items-center justify-center gap-3 text-center">
  <div class="border border-blue-200 bg-blue-50 text-blue-900 rounded-lg px-5 py-4"><b>오타</b><div class="text-sm opacity-60 mt-1">#897</div></div>
  <div class="text-2xl text-neutral-300">→</div>
  <div class="border border-blue-200 bg-blue-50 text-blue-900 rounded-lg px-5 py-4"><b>문서</b><div class="text-sm opacity-60 mt-1">#878+</div></div>
  <div class="text-2xl text-neutral-300">→</div>
  <div class="border border-blue-200 bg-blue-50 text-blue-900 rounded-lg px-5 py-4"><b>이슈 제안</b><div class="text-sm opacity-60 mt-1">#962</div></div>
  <div class="text-2xl text-neutral-300">→</div>
  <div class="border border-blue-300 bg-blue-500 text-white rounded-lg px-5 py-4"><b>기능</b><div class="text-sm opacity-70 mt-1">#929</div></div>
  <div class="text-2xl text-neutral-300">→</div>
  <div class="border border-blue-400 bg-blue-700 text-white rounded-lg px-5 py-4"><b>유지 작업</b><div class="text-sm opacity-70 mt-1">#967+</div></div>
</div>

<div class="mt-12 text-center text-lg text-neutral-600">
메인테이너는 기여 이력이 있는 사람의 PR을 더 잘 받아준다
</div>
<div class="mt-2 text-center text-xs text-neutral-400">
PR 수락 요인 연구 — Gousios et al. 2014 · Tsay et al. 2014
</div>

<!--
정리하면 이 순서입니다. 오타, 문서, 이슈, 기능, 유지 작업. 작은 기여부터 순서대로 올라갔습니다.
연구로도 확인된 사실인데, 메인테이너는 기여 이력이 있는 사람의 PR을 더 잘 받아줍니다.
메인테이너 손이 덜 타는 영역부터 기여하면서 이해도를 높이면, 메인테이너를 번거롭게 하는 질문이 줄어듭니다.
그렇게 기여 빈도와 기간을 늘려 가면서, 나중에는 메인테이너와 함께 어려운 문제를 풀어 보시길 바랍니다.
-->

---
layout: intro
class: bg-blue-600 text-white
---

<div class="text-sm tracking-widest opacity-70 mb-4">3부</div>

# 오픈소스 이력서 정리 방법

<!--
마지막으로, 이걸 이력서에 어떻게 쓰느냐입니다.
-->

---

# 개발자를 보는 여섯 축

<div class="mt-6 flex flex-col items-center">
  <img src="/images/hexagon-developer-book.jpeg" class="h-72 rounded-lg shadow-lg" alt="육각형 개발자 책 표지" />
  <div class="mt-4 text-sm text-neutral-400">『육각형 개발자』 (최범균, 한빛미디어)</div>
</div>

<!--
『육각형 개발자』라는 책이 있습니다. 제목처럼 개발자는 구현 하나가 아니라 여러 축으로 평가받는다는 관점입니다.
책이 말하는 여섯 축 — 구현 기술, 품질·코드 이해, 아키텍처·패턴, 응집도·결합도, 리팩터링·테스트, 업무 관리·공유.
이 축들을 오픈소스 기여로 어디까지 보여줄 수 있는지 정리해 봤습니다.
-->

---

# 여섯 축으로 본 내 기여

<div class="mt-2 flex items-center gap-8">

<svg viewBox="0 0 560 380" class="w-120 shrink-0" overflow="visible" aria-label="육각형 역량 그래프">
  <!-- grid rings: 하 40 / 중 80 / 상 120 -->
  <polygon points="280,150 314.6,170 314.6,210 280,230 245.4,210 245.4,170" fill="none" stroke="#e5e5e5" />
  <polygon points="280,110 349.3,150 349.3,230 280,270 210.7,230 210.7,150" fill="none" stroke="#e5e5e5" />
  <polygon points="280,70 383.9,130 383.9,250 280,310 176.1,250 176.1,130" fill="none" stroke="#d4d4d4" />
  <!-- axis lines -->
  <g stroke="#eeeeee">
    <line x1="280" y1="190" x2="280" y2="70" /><line x1="280" y1="190" x2="383.9" y2="130" />
    <line x1="280" y1="190" x2="383.9" y2="250" /><line x1="280" y1="190" x2="280" y2="310" />
    <line x1="280" y1="190" x2="176.1" y2="250" /><line x1="280" y1="190" x2="176.1" y2="130" />
  </g>
  <!-- data: 상,상,상,중,중,하 -->
  <polygon points="280,70 383.9,130 383.9,250 280,270 210.7,230 245.4,170" fill="rgba(37,99,235,0.15)" stroke="#2563eb" stroke-width="2" />
  <g fill="#2563eb">
    <circle cx="280" cy="70" r="4" /><circle cx="383.9" cy="130" r="4" /><circle cx="383.9" cy="250" r="4" />
    <circle cx="280" cy="270" r="4" /><circle cx="210.7" cy="230" r="4" /><circle cx="245.4" cy="170" r="4" />
  </g>
  <!-- labels -->
  <g fill="#404040" style="font-size:13px">
    <text x="280" y="52" style="font-size:13px;text-anchor:middle">구현 기술 <tspan fill="#2563eb" font-weight="bold">상</tspan></text>
    <text x="392" y="124" style="font-size:13px;text-anchor:start">품질 · 코드 이해 <tspan fill="#2563eb" font-weight="bold">상</tspan></text>
    <text x="392" y="262" style="font-size:13px;text-anchor:start">리팩터링 · 테스트 <tspan fill="#2563eb" font-weight="bold">상</tspan></text>
    <text x="280" y="334" style="font-size:13px;text-anchor:middle">응집도 · 결합도 <tspan font-weight="bold">중</tspan></text>
    <text x="168" y="262" style="font-size:13px;text-anchor:end">아키텍처 · 패턴 <tspan font-weight="bold">중</tspan></text>
    <text x="168" y="124" fill="#a3a3a3" style="font-size:13px;text-anchor:end">업무 관리 · 공유 <tspan font-weight="bold">하</tspan></text>
  </g>
</svg>

<div class="space-y-3 text-sm text-neutral-600">
  <div><b>구현 기술</b> — 라이브러리에 없던 타입 지원을 구현해 머지했다</div>
  <div><b>품질 · 코드 이해</b> — 처음 보는 코드에서 고칠 위치를 찾아냈고, 쓰지 않는 코드를 정리했다</div>
  <div><b>리팩터링 · 테스트</b> — 테스트를 먼저 작성하고 코드를 고쳐 나갔다</div>
  <div>응집도 · 결합도 — 기존 설계 안에서 수정하며 모듈 경계를 배웠다</div>
  <div>아키텍처 · 패턴 — 라이브러리의 설계와 패턴을 읽으며 배웠다</div>
  <div class="text-neutral-400">업무 관리 · 공유 — 마감과 우선순위 없이 하고 싶은 일만 골라서 한다</div>
</div>

</div>

<div class="mt-2 text-sm text-neutral-400">
상: 머지 기록으로 증명 · 중: 기여 과정에서 배움 · 하: 오픈소스로 드러나기 어려움
</div>

<!--
책의 여섯 축에 제 기여를 대응해 봤습니다.
상은 머지 기록으로 증명되는 축, 중은 기여 과정에서 배운 축입니다.
업무 관리는 오픈소스로 드러나기 어렵습니다. 마감과 우선순위 없이 하고 싶은 일만 골라서 하니까요.
-->

---

# AI 이후 달라진 머지 기록의 가치

<div class="mt-10">

| | AI 이전 | AI 이후 |
|---|---|---|
| PR이 증명하는 것 | 이 코드를 짤 수 있다 | **문제를 찾고, 합의하고, 검증을 통과했다** |
| 이력서에서의 역할 | 기술 스택의 근거 | **메인테이너가 검증한 공개 기록** |

</div>

<div class="mt-10 text-lg text-neutral-600">
AI가 코드를 대신 짜 주면서, <b>"만들었다"는 말만으로는</b> 실력을 보여주기 어려워졌다
</div>

<!--
AI가 코드를 대신 짜 주면서 "만들었다"는 말의 힘이 약해졌습니다. 머지는 다릅니다.
메인테이너가 심사해서 통과시킨 기록이고, 링크만 열면 누구나 확인할 수 있습니다.
-->

---

# 역량 한 문장 + PR 하나

<div class="mt-10 space-y-8">
  <div class="border-l-4 border-blue-600 pl-5">
    <div class="text-xl font-semibold">"처음 보는 대량 코드에 위축되지 않고 방향을 잡는다"</div>
    <div class="text-neutral-500 mt-2">테스트를 먼저 작성하며 수정 — fixture-monkey #929</div>
  </div>
  <div class="border-l-4 border-blue-600 pl-5">
    <div class="text-xl font-semibold">"드러난 오류에서 멈추지 않고 원인까지 추적한다"</div>
    <div class="text-neutral-500 mt-2">실행 시점부터 디버깅해 타입 변환 오류 발견 — fixture-monkey #967</div>
  </div>
</div>

<!--
PR 목록을 나열하면 활동만 보입니다. 역량 한 문장 뒤에 PR 하나를 증거로 붙입니다.
-->

---
layout: center
class: text-center
---

# 감사합니다

<div class="mt-10 text-neutral-500">
여러분의 첫 PR도 작아도 됩니다
</div>

<!--
오타 수정에서 시작해 기능 머지까지, 제 3개월이었습니다.
여러분의 첫 PR도 작아도 됩니다. 감사합니다.
-->
