# 출처

`gitignore` 는 repo devflow-data 의 `.gitignore` 를 바이트 그대로 옮긴 사본이다(이름에서 점을 뺀 것은 이 디렉터리에 규칙으로 걸리지 않게 하려는 것이다).

- 출처: repo devflow-data, commit 5e92e1c9171f6c01536e9f8acb893bb97cfda617 (T-0006 step-005 의 Run R-014 가 받은 checkout 의 HEAD). 그 파일을 마지막으로 바꾼 commit 은 63346fd (T-0002 step-001).
- 쓰는 곳: `tests/task-flow.test.ts` 의 AC7 테스트가 임시 git 디렉터리에 `.gitignore` 로 복사하고, Store 의 내부 파일이 실제로 있는 상태에서 `git status` 를 본다.
- 실제와의 대조: `npm run check-gitignore -- <데이터 repo 의 checkout>` 이 실제 `.gitignore` 가 내부 파일(이름은 `src/store/file/names.mjs`)을 모두 가리는지 본다. 데이터 repo 의 `.gitignore` 가 바뀌면 이 사본과 이 파일의 SHA 를 함께 고친다.
