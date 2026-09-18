# ADR-0009: TypeScript + Node.js LTS

- 상태: Accepted
- 날짜: 2026-09-18

## 상황
최종 형태는 서버 API, 웹 UI, CLI, 작업 실행기가 함께 있고, 네 곳 모두 같은 엔티티(Task, Step, Decision …)를 다룬다. 이 시스템의 가장 중요한 자산은 `schemas/` 다.

## 결정
- 언어는 TypeScript, 실행 환경은 Node.js LTS(현재 22).
- `schemas/*.json`(JSON Schema)이 기준 정의다. 런타임 검증은 `ajv`, 타입은 `json-schema-to-typescript` 로 생성한다. 생성된 타입은 commit 하지 않는다.
- CLI `commander`, 테스트 `vitest`, 패키지 관리 npm. 단일 패키지로 시작하고 서버화 시점에 `core / cli / server / web` workspace 로 나눈다.

## 이유
스키마에서 생성한 타입 하나를 CLI, 서버, 웹 UI 가 공유한다. Python 이면 웹 UI 를 만들 때 두 언어로 타입을 이중 관리하게 된다. 스트리밍·비동기(세션 관찰·개입)가 언어의 기본 모델이다. Windows 에서 CLI 배포가 간단하다.

## 포기한 대안
- Python: 데이터 분석에는 유리하나 UI 와 타입 공유 불가, Windows CLI 배포가 번거롭다.
- Go: 단일 바이너리 배포는 최고지만 UI 와 타입 공유 불가.
- Bun: Windows 에서 subprocess·파일 lock·git 을 많이 다루므로 가장 검증된 런타임을 택한다.
