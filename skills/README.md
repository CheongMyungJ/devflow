# Skills

처음에는 비어 있다. Skill 은 미리 설계하지 않고 운영 중에 **추출**한다 (ADR-0002).

## 승격 기준

- 회고(`docs/retro/`)에서 비슷한 Freeform Step 이 3~4회 이상 반복되었고
- 그 Step 들의 승인률이 높고 사람의 Step 정의 수정이 적었다

## 형태 (예정)

```
skills/<name>/
  skill.yaml        # name, version, description(카탈로그용 한 줄), params, step 템플릿
  worker.md         # 이 Skill 실행 시 Worker 에게 추가되는 지침
```

Planner 가 `skill: <name>@<version>` + params 를 지정하면 시스템이 `step.schema.json` 을 만족하는 Step 정의로 펼친다. 펼친 뒤의 실행 경로는 Freeform 과 동일하다.

버전은 올리기만 하고, 기존 버전은 Task 기록 재현을 위해 지우지 않는다.
