# Project Aura: 个人全天候智能伴侣文档集 (Personal Super-Agent)

本目录为基于 DeepSeek `dsh-superagent-prototype` 真实领域架构（[`000-philosophy.md`](../000-philosophy.md) ~ [`008-cookbook.md`](../008-cookbook.md)）改造个人智能伴侣系统的全套设计与实施文档。

---

## 📑 沉淀文档清单

1. **[产品需求文档 (PRD.md)](./PRD.md)**  
   * 定义了系统的产品愿景、核心痛点、注意力经济三大支柱与对齐 `dsh-superagent` 领域模型的系统架构图；
   * 规范了 Telegram `SourceKind` 准入与订阅扇出（Subscription Fan-out）契约、基于主动规则（Proactive Rule + Bot Trigger）的 08:00 晨间简报流水线、映射到 `Prompts`/`Store`/`knowledge` 的三层共生记忆架构，以及基于 `Attention (human_action)` 与命令 Shim 的 L1/L2/L3 权限分级契约。

2. **[完整技术实现方案 (TECHNICAL_ARCHITECTURE.md)](./TECHNICAL_ARCHITECTURE.md)**  
   * 详细阐述了如何零侵入复用 `Engine`、`Main Session (orchestrator)`、`DshExecutor` 与 `Outbox`；
   * 严格遵循 [`008-cookbook.md`](../008-cookbook.md) 设计了 `src/sources/telegram*.ts`、`KV.telegram`、`tg-cli` 受控传输协议、内联审批按钮回调闭环、VPS `dsh --profile superagent` 部署方案以及 `tests/telegram.spec.ts` 验证标准。

3. **[交互原型系统 (prototype.html)](./prototype.html)**  
   * 高保真、可交互的单文件 Web 原型；
   * 包含 **📱 Telegram 核心交互流**、**🗓️ Today.ai 仪表盘与 Living Memory 视图** 以及 **⚙️ 后台协调与执行器沙箱拓扑监控**，支持按钮点击反馈与状态联动。

---

## 🎯 核心设计哲学
> **"Take as little human attention as possible, and give as much value as possible."**  
> 尽可能少地消耗人类的注意力，尽可能多地交付确定的价值。默认静默，只在交付可用结果（`ready`）或必须人工决策（`attention`）时开口。
