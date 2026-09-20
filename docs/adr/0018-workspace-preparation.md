# ADR-0018: Task Workspace 준비 — 원격 기본값, 시작 SHA 고정, 중단 후 대조

- 상태: Accepted
- 날짜: 2026-09-20
- ADR-0008의 프로젝트 등록부 기본 branch 사용을 구체화하고, ADR-0017의 한 command = 한 commit 규약에 `prepareWorkspace`만 예외를 둔다.

## 상황

기존 발행 명령은 Task branch 이름을 기록하지만 실제 작업공간을 만들지 않는다. 다음 Runner가 실행할 자리를 준비해야 한다. 사용자는 기본 기준을 최신 원격 기본 branch로 정하고, 이름을 지정할 때 원격/로컬도 선택하되 생략하면 원격으로 정했다. 동시 호출은 충돌을 드러내고 중단하면 충분하며 자동 대기·잠금 회수는 요구하지 않았다.

## 결정

1. 발행 입력에 branch가 없으면 프로젝트 등록부의 원격 URL에서 `HEAD`의 symbolic ref를 조회한다. 등록부의 옛 `base_branch`나 로컬 `origin/HEAD`를 대체값으로 쓰지 않는다. 이름만 있으면 remote, local을 고르면 이름도 필수다. 새 Task에는 이름과 출처를 항상 기록한다. 출처 없는 옛 Task는 읽되 자동 Workspace 준비는 거부한다.
2. 최초 준비에서 remote는 해당 branch를 fetch하고 local은 로컬 branch를 해석한다. 여기서 최신의 시점은 fetch가 관찰한 원격 commit이다. SHA를 준비 의도로 기록한 뒤에는 재시도에서 다시 해석하지 않는다. 원격 실패를 오래된 추적 branch나 로컬 branch로 대체하지 않는다.
3. `Workspace` 인터페이스 뒤에 로컬 Git 구현을 두고 조립 지점에서 주입한다. CLI는 commands/queries만 호출한다. 공유 프로젝트 등록부와 머신 설정은 별도 설정 어댑터로 읽는다. 준비 기록의 정의는 스키마가 기준이다.
4. `prepareWorkspace`는 **의도 commit → Git 준비 → 완료 commit**의 다단계 command다. Store와 Git 사이의 원자성을 주장하지 않는다. 준비 의도·완료는 전용 이벤트로 기록하고 `appendEvents`로 받지 않는다. Task/Step status는 바꾸지 않는다. 실패는 시작 전과 준비 중으로 구별하며 후자는 기록이나 Git 변경이 남을 수 있다. 결과가 불명확한 Store commit은 기존 commit 식별자 확인 규약을 쓴다. CAS 충돌은 자동 재시도하지 않는다.
5. 로컬 관리 기록은 Git common directory 아래에 둔다. 요청 식별자·예정 위치·원격 URL을 대조해 다른 저장소/Task의 branch를 채택하지 않는다. 관리 기록은 공유 State Store가 아니며 머신 위치를 포함할 수 있다. Git 생성 성공과 검증 뒤 별도 완료 표식을 쓴다. 표식 없는 기존 worktree는 부분 checkout일 수 있어 자동 채택하지 않는다. 완료 기록이 없는 정상 작업공간은 재사용해 Store의 완료 기록을 보충한다.
6. 같은 Git 저장소의 생성 구간에는 즉시 실패하는 잠금 파일을 둔다. 대기·자동 재시도·stale 회수는 하지 않는다. 강제 종료로 잠금이 남으면 관련 devflow/Git 프로세스가 끝났는지 사람이 확인하고 잠금 파일만 제거한다. 그 뒤에도 부분 checkout이나 손상된 소유 기록은 수동 조치가 필요하다. 안전한 의도/Git 완료/Store 완료 경계에서 종료된 경우는 같은 명령으로 바로 이어간다.
7. Task branch가 이미 존재하면 최초 준비에서 거부한다. 관리하던 완료 worktree가 없어졌거나 branch/저장소가 달라졌으면 자동 재생성·reset하지 않는다. 준비 이후의 commit, staged/unstaged/untracked 변경은 보존한다. 설정의 clone과 worktree 루트는 서로 포함하지 않는다. merge·rebase·push·삭제·의존성 설치·실제 역할 실행은 이번 범위 밖이다.

## 이유

- 원격 기본값과 SHA 고정을 분리하면 Task 발행과 실행 사이의 최신 변경을 반영하면서 재시작의 시작점은 바뀌지 않는다.
- 두 commit 사이의 현실을 드러내면 Git 성공 뒤 기록 실패를 중복 생성으로 처리하지 않는다.
- 잠금 자동 복구나 불완전 checkout 복구를 추측하지 않아 기존 작업을 보존한다. 정상 단계 경계의 복구와 Git 도중 실패의 수동 조치를 구별한다.
- 머신 설정·로컬 관리 기록은 실행 구현에 남기고 공유 이벤트에는 repo/branch/SHA/식별자만 남긴다.

## 포기한 대안

- 현재 checkout branch 또는 캐시된 remote HEAD를 기본값으로 사용: 사용자가 정한 원격 기준과 다르다.
- 모든 Git 작업을 Store commit callback 안에서 실행: callback의 동기·무부작용 계약에 어긋나고 외부 작업은 rollback되지 않는다.
- 실패 시 branch/worktree를 삭제해 처음부터 생성: 사용자 변경과 성공한 Git 결과를 잃을 수 있다.
- 저장소 수준의 동시 작업 스케줄러와 잠금 회수: 이번 요구보다 크다. 충돌을 명시적으로 중단하는 것으로 충분하다.

## 검증 범위

로컬 bare 원격과 clone을 사용하는 통합 검사, 운영 스크립트 검사, 별도 프로세스를 준비 의도/Git 완료/Store 완료 경계에서 강제 종료하는 복구 검사를 둔다. Git 생성 도중의 불완전 상태와 남은 잠금은 자동 복구 성공으로 주장하지 않는다. Windows에서 실행하고 다른 OS의 실측 여부는 별도로 보고한다.
