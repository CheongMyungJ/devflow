# Workspace 실행 계약

결정 배경은 ADR-0018, 기록·설정 필드 정의는 `schemas/`가 기준이다. 인터페이스는 `src/workspace/types.ts`, 로컬 구현은 `src/workspace/git/`이다.

## 역할과 조립

`BaseBranchResolver.defaultBranch`는 Task 발행 중 원격 기본 branch를 조회한다. `Workspace.resolveBase`는 Git 준비 전 충돌을 검사하고 local branch 또는 fetch한 remote branch를 SHA로 해석한다. `ensure`는 고정된 준비 요청의 작업공간을 만들거나 재사용한다. `inspect`는 변경 없이 관찰한다. Store나 Task status 전이는 이 구현이 하지 않는다.

`FileProjectCatalog`는 공유 등록부와 머신 파일을 읽는다. 공유 URL과 clone의 설정된 remote URL이 일치해야 한다. URL 철자의 동치 추정(SSH/HTTPS 자동 변환 등)은 하지 않는다. Git 자체의 `insteadOf` 전송 설정은 존중한다. clone은 Git 작업공간 루트여야 하고 worktree 루트와 서로 포함할 수 없다. worktree 목적지가 symlink/junction으로 바뀌면 거부한다.

## 준비와 재시도

1. 준비 command가 Task와 이벤트를 읽는다. Task는 open이어야 한다.
2. 요청이 없으면 Workspace가 기준 SHA를 해석하고 command가 `expectedLastSeq`로 의도 이벤트를 기록한다. CAS 충돌은 중단한다. 요청이 있으면 Task와 일치하는지 확인해 그대로 사용한다.
3. 로컬 구현이 Git common directory의 잠금 파일을 `wx`로 만든다. 이미 있으면 즉시 중단한다. 획득 후 상태를 다시 대조한다.
4. 새 작업공간이면 소유 기록을 먼저 쓴 뒤 branch와 worktree를 만든다. 성공을 검증하고 로컬 완료 표식을 쓴다. 관리 중인 branch만 있고 worktree가 없다면 branch가 시작 SHA와 같을 때 이어갈 수 있다.
5. 정상적인 반환/오류에서는 자신이 얻은 잠금을 제거한다. 강제 종료에서는 남을 수 있으며 자동 회수하지 않는다.
6. command가 Task와 이벤트를 다시 읽고 완료 이벤트를 쓴다. Git 도중 Task가 닫혔거나 요청이 달라졌으면 결과물을 지우지 않고 중단한다.

이미 완료 이벤트가 있으면 생성하지 않고 검사만 한다. 현재 HEAD가 시작 SHA와 다른 것은 정상적인 작업 진행일 수 있으며 commit과 staged/unstaged/untracked 변경을 보존한다. Task branch 자체를 바꿨거나 다른 저장소를 가리키면 거부한다.

## 중단 상태

| 상태 | 자동 처리 |
|---|---|
| 의도만 있고 Git 변경 전 | 고정 SHA로 생성 |
| 소유 기록·시작 SHA의 branch만 존재 | 잠금이 없으면 worktree 생성 계속 |
| 로컬 완료 표식과 정상 worktree가 있고 Store 완료만 없음 | 기존 작업공간을 사용하고 완료 이벤트 보충 |
| Store도 완료 | 조회·재사용, 이벤트 추가 없음 |
| 잠금 잔여물 | 자동 처리 없음. 관련 devflow/Git 프로세스 종료 확인 후 사람이 잠금 파일 제거 |
| worktree는 있으나 로컬 완료 표식 없음 | 부분 checkout 가능성 때문에 수동 확인 |
| 손상된 소유 기록, 다른 요청/branch/repo, 완료 worktree의 유실 | 수동 확인. 덮어쓰기·reset·삭제·자동 재생성 없음 |

원격 fetch는 고유한 로컬 ref로 받아 다른 호출의 FETCH_HEAD와 섞이지 않게 한다. fetch나 의도 기록이 실패한 경우 이 ref가 남을 수 있다. 정리는 별도 후속 범위이며 작업 중 자동으로 지우지 않는다.

## 검증

`tests/workspace/`는 실제 bare 원격·clone, 로컬 변경 보존, 설정 검증, 출처 선택, fetch 실패, 명령 입구, 단계 경계에서 자식 프로세스 강제 종료를 검사한다. 정상 단계 경계의 복구와 Git 작업 도중 불완전 상태의 수동 조치를 별도로 검증한다. 자동 clone·의존성 설치·네트워크 인증 준비·worktree 정리는 하지 않는다. 준비된 위치에서 네 백엔드 Worker를 실행하는 경로는 별도 [Runner 계약](runner.md)과 `tests/runner/`에서 다룬다.

`workspace:code`의 종료 검증은 같은 Git 구현 경계의 `artifact.mjs`가 담당한다. branch·clean 상태·기준 SHA ancestry·현재 HEAD를 읽기 전용으로 확인하고 결과를 supervisor에 돌려준다. Workspace 준비나 수집 시 자동 commit/reset을 하지 않는다. 종료 시 고정한 SHA는 이후 수집 시점의 HEAD와 독립적이다 (ADR-0020).
