# Blog Writing Guide

이 문서는 `hello tis blog`에 글을 추가할 때 따르는 작성 기준이다.

## 글 작성 흐름

1. 글의 목적을 먼저 정한다.
   - 운영 기록: `Operations`
   - 개발 환경, 생산성, 내부 도구: `Platform`
   - API, 도메인, 제품 요구사항 구현: `Product`
   - AI 기능, 에이전트, RAG, 평가: `AI`
   - 주간 회고: `Weekly Review`
   - 연간 회고: `Annual Review`
2. `src/content/posts/` 아래에 Markdown 또는 MDX 파일을 만든다.
3. frontmatter를 먼저 작성한다.
4. 본문은 문제, 맥락, 판단, 결과 순서로 쓴다.
5. 이미지나 그래프가 있으면 원본 수치와 함께 남긴다.
6. `pnpm astro check`로 콘텐츠 스키마를 확인한다.

## 파일 이름

파일 이름은 URL이 되므로 영어 소문자와 하이픈을 사용한다.

```text
src/content/posts/2026-week-27-review.md
src/content/posts/deployment-checklist-as-platform.md
src/content/posts/api-permission-modeling.md
```

하위 폴더는 URL에 포함된다. 정리용 폴더가 필요하지만 URL에는 빼고 싶다면 `_`로 시작한다.

```text
src/content/posts/_drafts/not-routed.md
src/content/posts/_assets/image.png
```

## Frontmatter

모든 글은 아래 형태를 기본으로 한다.

```md
---
title: 배포 파이프라인을 제품처럼 다루기
description: CI/CD를 내부 사용자 경험 관점에서 개선한 기록입니다.
pubDatetime: 2026-07-02T00:00:00Z
tags:
  - Platform
---
```

허용되는 태그는 하나만 선택한다.

```text
Operations
Platform
Product
AI
Weekly Review
Annual Review
```

날짜는 UTC ISO 형식으로 쓴다. 한국 시간 기준으로 날짜만 중요하면 `T00:00:00Z`를 사용한다.

## 본문 구조

본문은 보고서처럼 고정된 목차를 채우기보다, 읽는 사람이 "무슨 일이 있었고, 왜 중요했고, 그래서 무엇을 배웠는지" 따라올 수 있게 쓴다.

기본 흐름은 아래와 같다.

```md
## 개요

처음 3~5문단 안에서 사건, 원인, 대응, 결과를 먼저 말한다.
장애나 성능 개선 글이라면 숫자를 여기서 바로 보여준다.

## 결과부터

벤치마크, 장애 건수, 처리량, 비용, 응답시간처럼 결론을 숫자로 보여준다.
성과가 핵심인 글일 때만 사용한다.

## 딥다이브 1 : 첫 번째 쟁점

문제를 작게 나누고, 조건 분기, 내부 동작, 선택지를 설명한다.
이미지, 표, 코드, 로그는 주장 바로 아래에 둔다.

## 딥다이브 2 : 두 번째 쟁점

앞 섹션에서 해결되지 않은 질문을 이어서 파고든다.
각 딥다이브는 독립적으로 읽혀도 이해될 만큼 좁게 잡는다.

## 마무리하며

무엇을 알게 됐는지, 어떤 기준이 생겼는지, 다음에는 무엇을 다르게 할지 적는다.
```

기술 트러블슈팅 글은 아래 구조를 우선 사용한다.

```md
## 개요

장애 건수, 에러 메시지, 직접 원인, 최종 대응을 먼저 요약한다.

## 딥다이브 1 : 현상 재현과 조건 분기

요청 흐름, 실패 조건, 로그 패턴을 정리한다.

## 딥다이브 2 : 원인 후보 비교

비슷해 보이는 원인들을 구분한다.

## 딥다이브 3 : 선택한 해결책의 부작용

해결책이 만든 새 문제, race condition, 성능 비용을 적는다.

## 마무리하며

운영 기준, 재발 방지 기준, 앞으로의 설계 원칙을 정리한다.
```

성능 개선이나 프로젝트 회고는 아래 구조를 우선 사용한다.

```md
## 개요

무엇을 만들었고 어떤 결과를 냈는지 말한다.

## 결과부터

성공률, 처리량, 응답시간, 비용 등 핵심 수치를 표로 보여준다.

## 발견한 트레이드오프

속도와 안정성, 비용과 품질, 생산성과 위험처럼 서로 당기는 기준을 설명한다.

## 최적화 과정

### 1단계 : AS-IS → TO-BE

변경 전후 흐름을 그림, 표, 코드로 비교한다.

### 2단계 : 병목 제거

병목이 어디였고 어떤 방식으로 제거했는지 적는다.

## 마무리

이번 경험으로 생긴 판단 기준과 남은 문제를 적는다.
```

생각 정리나 AI/업무 방식 회고는 아래 구조를 우선 사용한다.

```md
## 개요

최근 느낀 변화와 글의 핵심 주장을 먼저 적는다.

## 쟁점 1 : 첫 번째 긴장감

생산성은 올라가지만 역량이 약해질 수 있다처럼, 양쪽이 모두 맞는 문제를 다룬다.

## 쟁점 2 : 두 번째 긴장감

역할 변화, 책임, 검증, 오너십처럼 더 큰 관점으로 확장한다.

## 역할이 바뀐 지점

AS-IS / TO-BE 표로 변화한 역할을 정리한다.

## 앞으로 더 잘하기 위해 필요한 것

다음 행동, 습관, 학습 주제를 적는다.

## 마무리하며

내가 어떤 개발자가 되고 싶은지 한 문장으로 묶는다.
```

연간 회고는 아래 구조를 우선 사용한다.

```md
## 2026년, 어떤 걸 보여주고 싶었을까

한 해를 관통하는 한 문장과 감정을 먼저 적는다.

## 무엇을 했을까 - 개발 요소

업무 활동과 업무 외 활동을 링크 중심으로 정리한다.

### 좋은 경험이었던 일

대표 성공 경험 하나를 깊게 적는다.

### 아쉬웠던 일

대표 실패나 무산된 경험 하나를 깊게 적는다.

## 무엇을 했을까 - 비개발 요소

생활, 건강, 관계, 습관처럼 개발 밖에서 달라진 것을 적는다.

## 2026년, 터닝 포인트

전년 대비 달라진 태도나 행동을 적는다.

## 2026년, 나 자신을 이해한 해

무엇을 좋아하고 싫어하는지, 어떤 방향을 원하게 됐는지 적는다.

## 2027년의 목표

개발 목표와 비개발 목표를 나눠 적는다.
```

짧은 주간 회고는 이 구조만 사용해도 된다.

```md
## 이번 주에 바뀐 것

## 배운 것

## 다음 주에 할 것
```

글마다 모든 섹션을 채울 필요는 없다. 핵심은 `개요`에서 결론을 먼저 말하고, 본문에서는 질문을 하나씩 좁히며, 마지막에는 다음 판단 기준을 남기는 것이다.

## 이미지 추가

이미지는 기본적으로 Astro가 처리하게 둔다. 대부분의 스크린샷, 다이어그램, 그래프 이미지는 `src/assets/images/` 아래에 저장한다.

글마다 폴더를 만들고 이미지를 모은다.

```text
src/assets/images/deployment-checklist/dashboard-before.png
src/assets/images/deployment-checklist/dashboard-after.png
src/assets/images/deployment-checklist/deploy-lead-time.png
```

본문에서는 alias 경로로 참조한다.

```md
![배포 전 대시보드](@/assets/images/deployment-checklist/dashboard-before.png)
```

Astro가 빌드 시 이미지를 최적화하므로, 블로그 본문에 들어가는 이미지는 이 방식을 우선한다.

### public을 쓰는 예외

`public/`은 Astro가 이미지를 최적화하지 않는다. 아래 경우에만 사용한다.

- CSV, JSON, PDF처럼 원본 파일을 그대로 내려받게 할 때
- 외부 도구가 고정 URL을 요구할 때
- Astro 이미지 파이프라인이 처리하지 않아야 하는 파일일 때

## 이미지 규칙

- 파일명은 영어 소문자와 하이픈을 사용한다.
- 민감한 값, 토큰, 사용자 정보, 사내 URL은 가린다.
- 스크린샷은 필요한 영역만 자른다.
- 같은 글의 이미지는 `src/assets/images/{post-slug}/`에 모은다.
- alt text에는 이미지가 보여주는 정보를 적는다.
- 큰 이미지는 올리기 전에 압축한다.

## OG 이미지

기본적으로 OG 이미지는 자동 생성된다. 별도 이미지를 쓰고 싶을 때만 frontmatter에 추가한다.

```md
---
ogImage: ../../assets/images/deployment-checklist/og.png
---
```

권장 크기는 `1200 x 640`이다.

## 표와 수치

성능, 운영, 생산성 개선은 느낌보다 수치로 기록한다.

```md
| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| p95 latency | 420ms | 260ms | -38.1% |
| deploy lead time | 18m | 9m | -50.0% |
| alert noise | 42/week | 17/week | -59.5% |
```

수치에는 기준 기간을 함께 적는다.

```md
측정 기간: 2026-06-24 ~ 2026-06-30
대상: production API, business-hour traffic
계산: (after - before) / before * 100
```

## 그래프 반영

그래프는 이미지 하나만 올리지 말고 원본 수치도 같이 남긴다.

```md
![배포 리드타임 변화](@/assets/images/deployment-checklist/deploy-lead-time.png)

| Week | Lead time |
| --- | ---: |
| 2026-W24 | 18m |
| 2026-W25 | 14m |
| 2026-W26 | 11m |
| 2026-W27 | 9m |
```

반복해서 갱신할 그래프라면 같은 폴더에 원본 CSV를 둔다.

```text
src/assets/images/deployment-checklist/deploy-lead-time.png
public/data/deployment-checklist/deploy-lead-time.csv
```

본문에는 그래프 해석을 한 문장으로 붙인다.

```md
배포 리드타임은 4주 동안 18분에서 9분으로 줄었다. 가장 큰 변화는 수동 승인 단계를 제거한 뒤에 나타났다.
```

## 코드와 설정

코드는 언어와 파일명을 함께 적는다.

```ts file="src/content.config.ts"
tags: z.array(z.enum(TOPIC_TAGS)).length(1).default(["Platform"]);
```

변경 전후를 보여줄 때는 diff 표기를 사용한다.

```diff
- tags:
-   - Platform
+ tags:
+   - Weekly Review
```

## 체크리스트

글을 올리기 전에 확인한다.

- 태그가 허용 목록 중 하나인지 확인했다.
- 제목과 description이 본문 내용과 맞는다.
- 이미지에 민감 정보가 없다.
- 그래프에는 원본 수치나 표가 함께 있다.
- 수치에는 기간, 대상, 계산식이 있다.
- 링크가 상대 경로나 사이트 내부 경로로 올바르게 연결된다.
- `pnpm astro check`가 통과한다.

## 예시 명령

```bash
pnpm astro check
pnpm build
```
