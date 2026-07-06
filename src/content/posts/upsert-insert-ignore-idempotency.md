---
title: UPSERT, INSERT IGNORE 사용기 - 상태 변경과 멱등성 관리
description: 포인트 이력 관리에서 겪은 동시성과 성능 문제를 UPSERT와 INSERT IGNORE로 해결하며 상태 변경과 멱등성을 다룬 기록입니다.
pubDatetime: 2025-12-27T00:00:00Z
tags:
  - Product
---

### 개요

포인트 이력을 관리하면서 발생한 문제를 공유하려 한다. 현재 시스템은 이력 생성 → 포인트 사용 취소 시 해당 이력 취소 마킹(UPDATE) → 포인트 사용 취소 과정을 **분산락 + 요청 멱등성**으로 따닥 이슈를 방지하고 있다.

더 좋은 방법이 있을까 고민하던 중, [5천억건이 넘는 금융 데이터를 처리하는 토스 개발자에게 배우는 MySQL](https://www.inflearn.com/course/5%EC%B2%9C%EC%96%B5%EA%B1%B4%EC%9D%B4-%EB%84%98%EB%8A%94-%EA%B8%88%EC%9C%B5-%EB%8D%B0%EC%9D%B4%ED%84%B0%EB%A5%BC-%EC%B2%98%EB%A6%AC%ED%95%98/dashboard) 강의를 보고 `UPSERT`, `INSERT IGNORE`를 적용해본 내용을 정리한다.

### UPSERT - 상태 변경이 필요한 경우

#### `ON DUPLICATE KEY UPDATE` 란

`ON DUPLICATE KEY UPDATE`는 삽입 작업이 `UNIQUE` 제약조건을 위반하는 경우, 오류를 반환하지 않고 기존 행을 새 값으로 자동 업데이트하는 MySQL 문법이다.

```sql
INSERT INTO t1 (a,b,c) VALUES (1,2,3)
	ON DUPLICATE KEY UPDATE c=c+1;
```

- `INSERT` 성공 시: affected rows = 1
- `UPDATE` 실행 시: affected rows = 2

#### `ON DUPLICATE KEY UPDATE` 주의사항

**두 개 이상의 고유 인덱스가 일치하는 경우**, 첫 번째 인덱스만 업데이트된다. 아래 예시처럼 `a`와 `b` 컬럼 모두 `UNIQUE` 제약조건이 있다면, 내부적으로 다음과 같이 동작한다.

```sql
UPDATE t1 SET c=c+1 WHERE a=1 OR b=2 LIMIT 1;
```

따라서 두 개 이상의 고유 인덱스가 있는 테이블에는 이 구문 사용을 권장하지 않는다.

**INSERT vs UPDATE 제약조건 처리 차이**

`INSERT` 에서 `UNIQUE` 제약 조건에 위배되도 statement 는 실행된다. 그러나 `UPDATE` 에서 `UNIQUE` 제약 조건에 위배되면 오류를 반환한다.

```sql
-- 테이블 생성
CREATE TABLE t (a SERIAL, b BIGINT NOT NULL, UNIQUE KEY (b));
INSERT INTO t VALUES ROW(1,1), ROW(2,2);
TABLE t;

-- 실행: INSERT의 중복은 허용되지만, UPDATE의 b=b-1은 고유 키 위반으로 거부됨
INSERT INTO t VALUES ROW(2,3), ROW(3,3) ON DUPLICATE KEY UPDATE a=a+1, b=b-1;
```

`UPDATE` 제약조건 오류를 무시하려면 `IGNORE` 키워드를 사용한다.

```sql
Table t;
# 이전 결과
# a, b
# 1,1
# 2,2

INSERT IGNORE INTO t VALUES ROW(2,3), ROW(3,3)
ON DUPLICATE KEY UPDATE a=a+1, b=b-1;

# 이후 결과
# a, b
# 1,1
# 2,2
# 3,3
```

#### `ON DUPLICATE KEY UPDATE` 단점

- **동작 예측이 어려움**: 삽입과 업데이트 중 어떤 동작이 실행될지, 여러 조건에 맞는 row 중 어떤 것이 반영될지 예측하기 어려워 디버깅이 까다롭다.
- **AUTO_INCREMENT 값 낭비**: UPDATE가 실행되어도 AUTO_INCREMENT 값이 증가한다.

아래와 같이 실행했을 때, AUTO_INCREMENT 값 낭비되는 현상 확인이 가능하다.

```sql
CREATE DATABASE test_db;
CREATE TABLE test_table (a SERIAL, b BIGINT NOT NULL, UNIQUE KEY (b));

--- * 2회 실행
INSERT IGNORE INTO test_table VALUES ROW(2,3), ROW(3,3)
ON DUPLICATE KEY UPDATE a=a+1, b=b-1;

--- information_schema 캐시 갱신
ANALYZE TABLE test_table;

--- AUTO_INCREMENT 값 조회
SELECT TABLE_NAME, AUTO_INCREMENT
	FROM information_schema.TABLES
	WHERE TABLE_SCHEMA='test_db' AND TABLE_NAME='test_table';
```

> 이 때, information_schema 정보가 캐싱되서 이전 정보가 기록될 수 있으니 캐시 갱신이 필요하다.

#### `ON DUPLICATE KEY UPDATE` 관련 Lock 동작

`UPSERT`가 어떤 Lock을 사용하는지 실험해보았다. DB 격리 레벨은 `REPEATABLE-READ`다.

1. 1번 세션에서 `BEGIN` 후 `ON DUPLICATE KEY UPDATE` 실행. `COMMIT` 대기
2. 2번 세션에서 `BEGIN` 후 `ON DUPLICATE KEY UPDATE` 실행. `COMMIT` 대기
3. 3번 세션에서 `BEGIN` 후 `ON DUPLICATE KEY UPDATE` 실행. `COMMIT` 대기
4. 4번 세션에서 락 정보 조회

실제 사용한 쿼리는 다음과 같다.

```sql
INSERT INTO users (username, email, password_hash, display_name, login_count)
VALUES ('john_doe', 'john@example.com', SHA2('pass', 256), 'John', 1)
ON DUPLICATE KEY UPDATE login_count = login_count + 1;
```

락 정보를 조회했을 때 결과를 공유한다.

| ENGINE_TRANSACTION_ID | LOCK_TYPE | LOCK_MODE          | LOCK_STATUS | LOCK_DATA              |
| :-------------------- | :-------- | :----------------- | :---------- | :--------------------- |
| 539204                | TABLE     | IX                 | GRANTED     | null                   |
| 539205                | TABLE     | IX                 | GRANTED     | null                   |
| 539206                | TABLE     | IX                 | GRANTED     | null                   |
| 539204                | RECORD    | X                  | GRANTED     | 'john_doe', 20001      |
| 539204                | RECORD    | X                  | GRANTED     | supremum pseudo-record |
| 539204                | RECORD    | X,REC_NOT_GAP      | GRANTED     | 20001                  |
| 539205                | RECORD    | X,INSERT_INTENTION | WAITING     | supremum pseudo-record |
| 539206                | RECORD    | X,INSERT_INTENTION | WAITING     | supremum pseudo-record |

분석한 내용을 공유한다.

- 세 개의 트랜잭션(539204, 539205, 539206)이 존재한다.
- Lock 유형은 `TABLE-IX`, `RECORD-X`, `RECORD-REC_NOT_GAP`, `RECORD-INSERT_INTENTION`이 확인된다.
- 539205, 539206 트랜잭션의 `X` Lock 및 `INSERT_INTENTION` Lock이 대기 중이다.

**`TABLE`-`IX`(Intention Exclusive) Lock 이란**

테이블 전체 잠금과 행 잠금 간의 **충돌을 빠르게 감지**하기 위해서 테이블 수준에서 특정 행에 대해 행에 배타 잠금(X Lock)을 걸 예정임을 미리 표시한다.

**`RECORD`-`X`(Exclusive) Lock 이란**

행 수준의 배타 잠금으로, 해당 행에 대한 읽기와 쓰기를 모두 독점한다.

**`RECORD`-`INSERT_INTENTION` Lock 이란**

`Intention lock`은 테이블 수준 잠금으로, 트랜잭션이 나중에 테이블의 행에 대해 어떤 유형의 잠금(공유 또는 배타적)이 필요한지 표시한다. `ON DUPLICATE KEY UPDATE`는 `Intention lock`을 사용한다.

`PRIMARY`의 `RECORD` 데이터에서 `LOCK_DATA` 가 `supremum pseudo-record`로 설정된다. - > 현재 레코드에서 끝점까지 전부 대기한다.

| INDEX    | LOCK_MODE     | LOCK_DATA              | 설명                    |
| -------- | ------------- | ---------------------- | ----------------------- |
| username | X             | 'john_doe', 20001      | john_doe 레코드 + 앞 갭 |
| PRIMARY  | X,REC_NOT_GAP | 20001                  | id=20001 레코드만       |
| PRIMARY  | X             | supremum pseudo-record | 마지막 레코드 ~ 끝 갭   |

### `INSERT IGNORE` - 멱등성 관리가 필요한 경우

#### `INSERT IGNORE` 란

`INSERT IGNORE`는 삽입 시 `UNIQUE` 제약조건을 위반하면 오류를 발생시키지 않고 해당 행을 무시하는 MySQL 문법이다.

```sql
INSERT IGNORE INTO issue_history (transaction, company, history_id)
VALUES ('TX-001', 'EST', 123);
```

- 신규 삽입 시: affected rows = 1
- 중복 시: affected rows = 0 (오류 없이 무시)

#### `INSERT IGNORE` 주의사항

**AUTO_INCREMENT 값 증가**

중복으로 무시된 경우에도 AUTO_INCREMENT 값이 증가한다. `ON DUPLICATE KEY UPDATE`와 동일한 동작이며, 3. UPSERT, INSERT IGNORE 사용기 - 상태 변경과 멱등성 관리 해당 글에서 AUTO_INCREMENT 값 증가되는 문제 확인 가능하다.

### UPSERT 실사례 1 : 포인트 거래 발생 날짜 관리(Flag 기반 테이블 관리)

**실사례 1 상황**

포인트 정산시 과거 날짜는 변경이 적은 상황에서 전체를 스캔하는 것은 비효율적이다. 변경이 발생한 날짜를 표시(Change Flag)하고, 정산 시점에 표시된 날짜만 재계산(Lazy Evaluation)한다.

변경이 발생한 날짜만 정산하기 위해 플래그 기반 추적을 도입했다. 포인트 작업이 발생하면 해당 날짜에 Change Flag를 표시하고, 배치에서는 플래그가 있는 날짜만 재정산한다.

```
	   변경 플래그 테이블
┌─────────────┬────────────┐
│ target_date │ is_changed │
├─────────────┼────────────┼
│ 2025-01-10  │ true       │ ← 재정산 필요
│ 2025-01-11  │ false      │ ← 정산 완료
│ 2025-01-12  │ true       │ ← 재정산 필요
└─────────────┴────────────┘
```

**실사례 1 문제**

상태 전이로 표현하면 다음과 같다.

```
 [레코드 없음]
      │
      │ 포인트 작업 발생
      ▼
┌─────────────┐
│ is_changed  │
│   = true    │ ◀─────────────────┐
└──────┬──────┘                   │
       │                          │
       │ 정산 배치 완료               │ 포인트 작업 발생
       ▼                          │ (적립/사용/취소)
┌─────────────┐                   │
│ is_changed  │ ──────────────────┘
│   = false   │
└─────────────┘
```

**실사례 1 원인**

초기 구현은 다음과 같았다.

```kotlin
fun recordDate(historyDate: LocalDate) {
	// 1. SELECT 쿼리
	val nowRecord = repository.find(historyDate)
	// 2. 없으면 INSERT
		?: repository.save(PointAccountingRecord(historyDate))
	// 3. 조건부 UPDATE
	if (nowRecord.isChanged != historyDate.isChanged) {
		repository.update(nowRecord.change())
	}
}
```

**동시성 문제 (Race Condition)**

- 동시에 들어온 두 요청이 각각 `SELECT`를 수행하여 "레코드 없음"을 확인한 뒤, 둘 다 `INSERT`를 시도했다. `UNIQUE` 제약조건에 의해 먼저 커밋된 요청만 성공하고 나머지는 `Duplicate Key` 오류로 실패했다.

**성능 문제**

- **불필요한 조회 발생**: 이미 `is_changed = true`인 상태에서도 매번 `SELECT`로 상태를 확인해야 했다. 동일 날짜에 포인트 거래가 100번 발생하면 100번 조회가 수행되지만, 실제 `UPDATE`가 필요한 경우는 최초 1번뿐이다.
- **다중 쿼리 발생**: 플래그 하나를 표시하는 작업에 `SELECT` → `INSERT` 또는 `SELECT` → `UPDATE`로 최소 2번의 DB 호출이 필요했다.

**실사례 1 해결**

`UPSERT`를 적용하여 단일 쿼리로 개선했다.

```sql
INSERT INTO point_accounting_record (target_date, is_changed)
VALUES (#{targetDate}, true)
ON DUPLICATE KEY UPDATE is_changed = true;
```

- **Race Condition 해결**: InnoDB에서 하나의 SQL 쿼리는 원자적으로 처리된다.
- **다중 쿼리 해결**: 존재하면 UPDATE, 존재하지 않으면 INSERT를 수행하며 2번의 호출이 1번으로 줄었다.

**여전히 남은 문제: 불필요한 UPDATE**

Change Flag 값이 이미 `true`여도 `UPDATE` 구문 자체는 실행된다. 값이 동일하면 MySQL이 실제 디스크 쓰기를 스킵하지만, 쿼리 파싱과 실행 비용은 발생한다.

DB 호출 자체를 줄이려면 **애플리케이션 레벨 캐싱**이 필요하다. 이미 `true`로 변경된 날짜는 캐시에 저장하고, 해당 날짜에 대한 추가 요청은 DB 호출 없이 무시하는 방식이다.

### UPSERT 실사례 2 - 포인트 총액 계산 방법 (상태 스냅샷 관리)

**실사례 2 상황**

포인트 이력 테이블에 모든 적립, 사용, 취소 기록을 저장하고, 잔액이 필요할 때마다 이력을 집계하고 있다.

**실사례 2문제**

활성 사용자가 많아지면 이력이 계속 쌓이고, 매 조회마다 전체를 집계해야 한다. 데이터가 늘어날수록 조회 성능이 저하된다.

```sql
SELECT SUM(
    CASE
        WHEN action_type IN ('EARN', 'CANCEL_REDEEM') THEN initial_point
        WHEN action_type IN ('REDEEM', 'CANCEL_EARN') THEN -initial_point
    END
) AS balance
FROM point_history
WHERE user_id = ? AND is_cancel = false;
```

**실사례 2해결**

잔액을 매번 계산하지 않고, **포인트 작업 시점에 미리 계산된 잔액을 별도 테이블에 저장**한다. 스냅샷 갱신은 포인트 작업과 **같은 트랜잭션**에서 처리하여 정합성을 보장한다.

```sql
-- 적립 시
INSERT INTO user_point_snapshot (user_id, total_point)
	VALUES (?, ?) AS new
	ON DUPLICATE KEY UPDATE total_point = total_point + new.total_point;

-- 사용 시
UPDATE user_point_snapshot
	SET total_point = total_point - ?
	WHERE user_id = ?;
```

캐싱과의 비교 했을 때, 포인트처럼 불일치가 치명적인 데이터는 트랜잭션으로 정합성을 보장할 수 있는 DB 스냅샷 방식이 적합하다. 불일치 문제를 우려한다면, 트랜잭션으로 정합성 보장할 수 있는 DB 스냅샷 방식이 적합하다.

| 항목            | DB 스냅샷               | Redis 캐싱          |
| --------------- | ----------------------- | ------------------- |
| 트랜잭션 정합성 | ✅ DB 트랜잭션으로 보장 | ❌ 별도 동기화 필요 |
| 인프라          | DB만 사용               | Redis 필요          |
| 데이터 유실     | 낮음                    | 휘발 가능성 있음    |

**고려사항: Row Lock 경합**

동일 `user_id`에 대한 `UPDATE`가 집중되면 Row Lock 경합이 발생할 수 있다. 다만 InnoDB의 Row Lock은 해당 Row만 잠그므로, 특정 사용자의 작업이 다른 사용자에게 영향을 주지는 않는다.

트랜잭션이 오래 유지되면 Undo Log가 비대해질 수 있으므로, **트랜잭션 범위를 최소화**하는 것이 중요하다. 특히 트랜잭션 내에서 외부 API 호출 등 지연이 발생할 수 있는 작업은 트랜잭션 밖으로 분리해야 한다.

> 현재 서비스에서는 기존 Redis 분산락 사용 시에도 락 경합이 거의 없는 수준이라, Row Lock 경합 문제는 크게 우려되지 않는다.

### `INSERT IGNORE` 실사례 1 : 트랜잭션 ID 관리

**실사례 1 상황**
외부 제휴사에서 포인트 적립 요청이 들어올 때, 동일한 트랜잭션 ID로 중복 요청이 빈번했다. 동일한 요청은,포인트가 중복 적립되지 않도록 방지해야 했다. 현재는 분산락과 중복 검증 쿼리로 이를 처리하고 있다.

```kotlin
@DistributedLock(key = "포인트 발급 키")
fun issuePoint(...) {
    // 1. 트랜잭션 ID 중복 검증 - 이미 처리된 요청이면 예외 발생
    issueHistoryService.validIssue(command.company, command.transaction)
    // 2. 트랜잭션 실행
    return transactionHandler.runInTransaction {
        // 3. 이력 저장
        issueService.issuePoint(...)
        // 4. 포인트 적립
        earnService.earnPoint(...)
    }
}
```

**실사례 1 문제 : 비효율**

- 분산락 의존으로 인한 비효율 : 순차적 처리를 위해 Redis 를 사용하고 있다.
- 다중 쿼리 : SELECT → INSERT로 2번의 DB 호출하고 있다.

**실사례 1 해결: INSERT IGNORE 적용**

분산락 없이 DB 제약조건만으로 중복을 방지할 수 있다면, 구조가 훨씬 단순해진다.

```sql
-- 1. 선점 시도 (affected rows로 중복 판단)
INSERT IGNORE INTO issue_history (transaction, company, history_id)
VALUES ('TX-001', 'EST', 0);
-- affected rows = 1 → 신규, 0 → 중복
```

affected rows로 중복을 판단하면서 문제를 해결할 수 있다.

- **분산락 의존 문제 해결** : DB의 `UNIQUE` 제약조건이 중복을 방지하므로 Redis 분산락이 불필요해진다. 동시 요청이 들어와도 DB 레벨에서 원자적으로 처리된다.
- **다중 쿼리 문제 해결** : SELECT 없이 `INSERT IGNORE` 한 번으로 중복 확인과 저장을 동시에 처리한다. affected rows 값으로 신규(1) 또는 중복(0)을 즉시 판단할 수 있다.

### 마무리하며

문제 해결 방법은 다양하다. 같은 문제라도 비효율적인 방식부터 효율적인 방식까지 여러 선택지가 존재한다. 결국 내가 얼마나 알고 있느냐에 따라 선택할 수 있는 해결책의 폭이 달라진다. 이번 경험을 통해 꾸준히 공부하는 습관이 제품의 유지보수성을 높이는 데 직접적인 영향을 준다는 것을 다시 한번 느꼈다.

`UPSERT`는 처음 접하는 개념이라 도입하는 데 우려가 컸다. 성능 이슈는 없을지, 내가 모르는 동작으로 인해 예상치 못한 문제가 발생하지는 않을지 걱정이 앞섰다. 하지만 이번 기회에 동작 원리와 장단점을 분석하고, Lock 동작까지 직접 실험하며 확인했다. 그 과정에서 UPSERT를 제대로 이해하게 되었고, 덕분에 실제 적용에는 큰 어려움이 없었다.

이번 글에서는 `INSERT IGNORE`를 활용해 분산락 없이 멱등성을 보장하는 방법을 정리했다. DB의 `UNIQUE` 제약조건이 중복을 방지하고, affected rows 값 하나로 신규와 중복을 판단할 수 있게 되었다. 분산락이 빠지면서 Redis 의존성도 줄었다.

앞서 작성한 UPSERT 와 마찬가지로, 이번에도 새로운 방식을 도입하기 전에 동작 원리를 먼저 파악했다. 그 과정에서 `INSERT IGNORE`와 `ON DUPLICATE KEY UPDATE`의 차이, 각각의 적합한 사용처를 명확히 이해하게 되었다.

- **INSERT IGNORE** : 없으면 삽입, 있으면 무시 → **멱등성 관리에 적합**
- **ON DUPLICATE KEY UPDATE** : 없으면 삽입, 있으면 갱신 → **상태 변경이 필요한 경우에 적합**

단순한 차이지만, 상황에 맞는 선택이 코드의 의도를 명확하게 만들어준다.
