# ADR-0010: Rename Default Frontdesk to Template

- **Status**: Accepted
- **Date**: 2026-05-20
- **Decider(s)**: 用户（项目负责人）
- **Tags**: `naming`, `refactor`, `frontdesk`
- **Supersedes**: —
- **Superseded by**: —

> **Addendum (later generalization)**: 本 ADR 记录的是历史命名决策，当时品牌仍是 `frontlane`。此后品牌已被泛化为可配置的 `agentdesk` 命名空间（display `AgentDesk` / machine `agentdesk`），默认 frontdesk 文件夹现为 `agentdesk-frontdesk`。下文保留原始决策措辞以记录真实历史；其中"模板而非默认业务 Agent"的判断在新命名下依然成立。

---

## Context

平台引入了双 Frontdesk 架构：
- 主 Frontdesk（Primary）— 通用企业客服代表，英文提示词
- 实验室 Frontdesk（Secondary）— 实验室助手

但实际使用中发现命名歧义：
- `frontlane-frontdesk` 的名字暗示它是"默认/正统 frontdesk"
- 实际上它是**框架参考模板**（hello-world 级别的演示 Agent）
- 本项目真正使用的是 `frontlane-lab-frontdesk`

这导致新开发者容易误用模板而非真实业务 Agent。

## Options Considered

- **Option A — Rename to `frontlane-template-frontdesk`**：把 `frontlane-frontdesk` 改名为 `frontlane-template-frontdesk`，`FrontLane Desk` 改名为 `FrontLane Template Desk`。新增 LEGACY fallback 保持向后兼容。
- **Option B — Rename to `frontlane-reference-frontdesk`**：类似 A，但用 `reference` 替代 `template`。
- **Option C — 交换主次**：让 lab desk 成为 `DEFAULT_FRONTDESK_FOLDER`。破坏性变更。
- **Option D — 不改名，只改文档**：零侵入，但名字歧义未解决。

## Decision

> **拍板**：选 **Option A — Rename to `frontlane-template-frontdesk`**。

理由：
1. `template` 直观表达角色（"这是模板，不是业务 Agent"）
2. 向后兼容：LEGACY fallback 机制让现有部署无感知过渡
3. 改动面可控：16 个文件，全部可搜索替换

## Consequences

- **Positive**：命名准确反映角色，减少新开发者误用
- **Negative**：需要更新 16 个文件 + 2 份报告 + 1 份 ADR
- **Neutral**：现有部署通过 LEGACY fallback 自动兼容

## Implementation Notes

- 修改 `src/branding.ts`：常量值 + LEGACY fallback
- 修改 3 个脚本、4 个测试、5 个文档、2 个报告
- 新建本 ADR（ADR-0010）

## References

- Frontdesk 拓扑与 onboarding 策略（双 Frontdesk 架构）
