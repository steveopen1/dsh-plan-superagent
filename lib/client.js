window.__ModuleLoader__.load({
	id: "dsh-plan-superagent",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		// src/client/index.ts
		/**
		* dsh-plan-superagent client：面板（宿主右侧栏的一个 tab）+ 会话头部入口 + 输入栏旁的模式开关。
		* 两必坑（骨架实测）：apply 用 ctx.slots 必须 export const inject = ['slots']；register 必带 name。
		* M2 第一批：/stream NDJSON 实时 + 主题跟随（采样 body 亮度）。
		* M2 第三批（本文件主体）：面板直编辑——点选节点出编辑卡（标题/备注/验收/scope/优先级/依赖多选）、
		* 自由拖拽节点（位置持久化 pos）、拖拽连线改依赖（A 拖到 B = B 依赖 A，再拖一次 = 移除）、
		* ＋子任务 / 删除节点；一切改动先进草稿态，点「保存更改」才 POST /edit 生效（用户拍板：不保存不生效）。
		*/
		const NS = "dsh-plan-superagent";
		const API = "/_dsh/dsh-plan-board";
		const POLL_MS = 4e3;
		/** 面板记住的项目路径（localStorage 键）。与旧插件的键分开存，避免两个插件互相覆盖对方的项目路径。 */
		const PROJECT_KEY = "dsh-plan-superagent.project";
		const PROJECT_KEY_OLD = "planboard.project";
		/** 读面板的项目路径：优先新键；没有就从旧键搬一次（改名升级不丢用户已选的项目）。 */
		function loadProject() {
			const v = localStorage.getItem(PROJECT_KEY);
			if (v != null) return v;
			return localStorage.getItem(PROJECT_KEY_OLD) ?? "";
		}
		/**
		* 浏览器端的绝对路径判定（不能用 node:path）。
		* 面板要接受用户在本机填的项目根：Windows 下是 `C:\path`（或 `C:/path`），
		* POSIX 下是 `/path`。上游原实现只认 startsWith('/')，在 Windows 上等于永不成立。
		*/
		const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/])/;
		function isAbsoluteProject(p) {
			return ABS_PATH_RE.test(p);
		}
		/** 多行文本 -> 字符串数组（每行一条，去空行）。 */
		function splitLines(s) {
			return s.split("\n").map((x) => x.trim()).filter((x) => x !== "");
		}
		/** 宽松取字符串数组（服务端字段可能缺失或类型不对）。 */
		function strArr(v) {
			return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
		}
		/** 宽松取数字（缺失 -> null：区分「没设优先级」与「优先级 0」）。 */
		function numOr(v) {
			return typeof v === "number" && Number.isFinite(v) ? v : null;
		}
		/** update_node.fields 白名单归一化：只保留 applyOps 认识的键（status 故意不给 —— 服务端会抛）。 */
		function normFields(v) {
			const o = v ?? {};
			const out = {};
			if (typeof o.title === "string") out.title = o.title;
			if (typeof o.note === "string") out.note = o.note;
			if (Array.isArray(o.acceptance)) out.acceptance = strArr(o.acceptance);
			if (Array.isArray(o.scope)) out.scope = strArr(o.scope);
			if (typeof o.priority === "number") out.priority = o.priority;
			if ("parent" in o) out.parent = o.parent == null ? null : String(o.parent);
			if (Array.isArray(o.deps)) out.deps = strArr(o.deps);
			if ("pos" in o) out.pos = o.pos;
			return out;
		}
		/** 服务端 ops（unknown[]）-> 面板可编辑的强类型 ops；认不出的 op 直接丢弃。 */
		function normOps(raw) {
			const out = [];
			if (!Array.isArray(raw)) return out;
			for (const item of raw) {
				if (item == null || typeof item !== "object") continue;
				const o = item;
				const kind = String(o.op ?? "");
				if (kind === "init_board") out.push({
					op: "init_board",
					name: String(o.name ?? ""),
					goal: String(o.goal ?? "")
				});
				else if (kind === "add_node") {
					const n = o.node ?? {};
					out.push({
						op: "add_node",
						node: {
							id: String(n.id ?? ""),
							type: n.type === "task" ? "task" : "module",
							title: String(n.title ?? ""),
							parent: n.parent == null ? null : String(n.parent),
							deps: strArr(n.deps),
							priority: numOr(n.priority),
							acceptance: strArr(n.acceptance),
							scope: strArr(n.scope)
						}
					});
				} else if (kind === "update_node") out.push({
					op: "update_node",
					id: String(o.id ?? ""),
					fields: normFields(o.fields)
				});
				else if (kind === "remove_node") out.push({
					op: "remove_node",
					id: String(o.id ?? "")
				});
				else if (kind === "set_deps") out.push({
					op: "set_deps",
					id: String(o.id ?? ""),
					deps: strArr(o.deps)
				});
			}
			return out;
		}
		/** 单条 op 的比较键（字段顺序无关；只比较服务端真正会应用的字段）。 */
		function canonOp(op) {
			if (op.op === "init_board") return JSON.stringify([
				"init_board",
				op.name,
				op.goal
			]);
			if (op.op === "add_node") return JSON.stringify([
				"add_node",
				op.node.id,
				op.node.type,
				op.node.title,
				op.node.parent,
				[...op.node.deps].sort(),
				op.node.priority,
				op.node.acceptance,
				op.node.scope
			]);
			if (op.op === "update_node") {
				const f = op.fields;
				return JSON.stringify([
					"update_node",
					op.id,
					f.title ?? null,
					f.note ?? null,
					f.acceptance ?? null,
					f.scope ?? null,
					f.priority ?? null,
					f.parent ?? null,
					f.deps ?? null,
					f.pos ?? null
				]);
			}
			if (op.op === "remove_node") return JSON.stringify(["remove_node", op.id]);
			return JSON.stringify([
				"set_deps",
				op.id,
				[...op.deps].sort()
			]);
		}
		/** 两组 ops 语义上是否不同（决定「确认生效」要不要带 ops 覆盖原提案）。 */
		function opsChanged(a, b) {
			if (a.length !== b.length) return true;
			for (let i = 0; i < a.length; i++) if (canonOp(a[i]) !== canonOp(b[i])) return true;
			return false;
		}
		/** 面板 op -> 回传服务端的线格式（形状必须与 applyOps 一致）。 */
		function toWire(op) {
			if (op.op === "init_board") return {
				op: "init_board",
				name: op.name,
				goal: op.goal
			};
			if (op.op === "add_node") {
				const node = {
					id: op.node.id,
					type: op.node.type,
					title: op.node.title,
					parent: op.node.parent,
					deps: op.node.deps,
					acceptance: op.node.acceptance,
					scope: op.node.scope
				};
				if (op.node.priority != null) node.priority = op.node.priority;
				return {
					op: "add_node",
					node
				};
			}
			if (op.op === "update_node") return {
				op: "update_node",
				id: op.id,
				fields: op.fields
			};
			if (op.op === "remove_node") return {
				op: "remove_node",
				id: op.id
			};
			return {
				op: "set_deps",
				id: op.id,
				deps: op.deps
			};
		}
		/** 提案应用后的依赖图（id -> deps）：板子现状 + 提案里的增删改。 */
		function proposalDepGraph(base, ops) {
			const g = /* @__PURE__ */ new Map();
			for (const n of base) g.set(n.id, [...n.deps ?? []]);
			for (const op of ops) {
				if (op.op === "add_node") {
					g.set(op.node.id, [...op.node.deps]);
					continue;
				}
				if (op.op === "update_node") {
					const d = op.fields.deps;
					if (Array.isArray(d)) g.set(op.id, [...d]);
					continue;
				}
				if (op.op === "set_deps") {
					g.set(op.id, [...op.deps]);
					continue;
				}
				if (op.op === "remove_node") {
					g.delete(op.id);
					for (const [k, v] of g) g.set(k, v.filter((x) => x !== op.id));
				}
			}
			return g;
		}
		/**
		* 提案里会不会依赖成环（返回成环路径，空串 = 无环）。
		* 服务端 lint 也会兜底，但前端先挡住：否则用户点「确认生效」才被服务端拒，现场很难看懂。
		*/
		function proposalCycle(base, ops) {
			const items = [...proposalDepGraph(base, ops).entries()].map(([id, deps]) => ({
				id,
				deps
			}));
			const byId = new Map(items.map((i) => [i.id, i]));
			const color = /* @__PURE__ */ new Map();
			const stack = [];
			let cycle = [];
			const dfs = (id) => {
				if (cycle.length > 0) return;
				const c = color.get(id);
				if (c === 2) return;
				if (c === 1) {
					cycle = stack.slice(stack.indexOf(id)).concat([id]);
					return;
				}
				color.set(id, 1);
				stack.push(id);
				for (const d of byId.get(id)?.deps ?? []) {
					if (!byId.has(d)) continue;
					if (color.get(d) === 1) {
						cycle = stack.slice(stack.indexOf(d)).concat([d]);
						return;
					}
					if (color.get(d) == null) dfs(d);
					if (cycle.length > 0) return;
				}
				stack.pop();
				color.set(id, 2);
			};
			for (const i of items) {
				dfs(i.id);
				if (cycle.length > 0) break;
			}
			return cycle.length === 0 ? "" : cycle.join(" -> ");
		}
		/**
		* 提案里 task 的父模块是否可解。
		* 删掉某个模块的 add_node，它名下的任务就成了孤儿 —— 服务端 applyOps 会抛 BAD_PARENT，前端先提醒。
		*/
		function proposalParentIssues(base, ops) {
			const moduleIds = new Set(base.filter((n) => n.type === "module").map((n) => n.id));
			for (const op of ops) if (op.op === "add_node" && op.node.type === "module") moduleIds.add(op.node.id);
			const issues = [];
			for (const op of ops) {
				if (op.op !== "add_node" || op.node.type !== "task") continue;
				const p = op.node.parent;
				if (p == null || !moduleIds.has(p)) issues.push("任务 " + op.node.id + " 的父模块 " + (p ?? "(空)") + " 不在板子/提案里 —— 批准会被服务端拒");
			}
			return issues;
		}
		/** 依赖候选项合并（提案新增的节点覆盖板子里同 id 的旧标题）。 */
		function mergeDepOptions(base, extra) {
			const out = base.slice();
			for (const e of extra) {
				const i = out.findIndex((x) => x.id === e.id);
				if (i >= 0) out[i] = e;
				else out.push(e);
			}
			return out;
		}
		/** 错误体 -> 可读文本（服务端两种形状：字符串 / {code,message}）。 */
		function errText(e) {
			if (e == null) return "未知错误";
			if (typeof e === "string") return e;
			if (typeof e === "object") {
				const o = e;
				if (typeof o.message === "string") return o.message;
				if (typeof o.code === "string") return o.code;
			}
			return String(e);
		}
		/** 安全读 JSON（404/网关可能回 HTML，抛 SyntaxError 对用户没意义）。 */
		async function readJson(r) {
			try {
				return await r.json();
			} catch {
				return {
					ok: false,
					error: "HTTP " + r.status + "：响应不是合法 JSON"
				};
			}
		}
		/** 文本截断（标签太长会把面板挤爆）。 */
		function clip(s, n) {
			return s.length > n ? s.slice(0, n - 1) + "…" : s;
		}
		/** 子导图的规范字段名（其余都算「未知字段」）。 */
		const DESIGN_FIELDS = [
			"summary",
			"steps",
			"files",
			"risks",
			"tests"
		];
		/** 任意 JSON → 规范形状（不崩：缺字段补空，类型不对当空，未知字段进 extra）。 */
		function normDesign(raw) {
			const o = raw != null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
			const extra = {};
			for (const k of Object.keys(o)) if (!DESIGN_FIELDS.includes(k)) extra[k] = o[k];
			return {
				summary: typeof o.summary === "string" ? o.summary : "",
				steps: strArr(o.steps),
				files: strArr(o.files),
				risks: strArr(o.risks),
				tests: strArr(o.tests),
				extra
			};
		}
		/** 规范形状 → 回写形状（未知字段一起带回去）。 */
		function designToWire(d) {
			return {
				summary: d.summary,
				steps: d.steps,
				files: d.files,
				risks: d.risks,
				tests: d.tests,
				...d.extra
			};
		}
		/** 空的子导图（给「新建」用）。 */
		function emptyDesign() {
			return {
				summary: "",
				steps: [],
				files: [],
				risks: [],
				tests: [],
				extra: {}
			};
		}
		/**
		* 任务的 note 里带 design-graph 指针 = 它有子导图。
		* 不用额外接口就能知道「有没有」，点开时再拉内容。
		*/
		function hasDesignPointer(note) {
			return typeof note === "string" && note.includes("design-graph:");
		}
		/** 模式值归一：只认 'plan' / 'direct'，别的（缺字段/脏数据）当没有。 */
		function normalizeMode(v) {
			return v === "plan" || v === "direct" ? v : null;
		}
		/** 会话 id 归一（空串/缺失都算没有）。 */
		function normalizeSessionId(v) {
			if (typeof v !== "string") return null;
			const s = v.trim();
			return s === "" ? null : s;
		}
		/**
		* 会话 id 的取法。
		* 主路径：插槽注册里的 inject(sessionId) —— 宿主渲染输入栏时按会话注入，
		* 证据：宿主 slots 运行时的 runInject 会把 scope 绑定的 key（即会话 id）作为第一个实参传给 inject。
		* 兜底：URL 上的 session/sessionId 参数（宿主将来换路由也不至于瞎猜）。
		*/
		function resolveSessionId(prop, loc) {
			const direct = normalizeSessionId(prop);
			if (direct != null) return direct;
			try {
				const l = loc ?? (typeof window === "undefined" ? null : window.location);
				if (l == null) return null;
				const q = new URLSearchParams(l.search ?? "");
				const hash = (l.hash ?? "").replace(/^#/, "");
				const h = new URLSearchParams(hash);
				const path = /\/session\/([^/?#]+)/.exec(hash);
				return normalizeSessionId(q.get("session") ?? q.get("sessionId") ?? h.get("session") ?? h.get("sessionId") ?? (path == null ? null : path[1]));
			} catch {
				return null;
			}
		}
		/** 开关文案：关 = 直改，开 = 计划板：开（一眼看出当前模式）。 */
		function modeLabel(mode) {
			return mode === "plan" ? "计划板：开" : "直改";
		}
		/** 点击切换的目标模式。 */
		function nextMode(mode) {
			return mode === "plan" ? "direct" : "plan";
		}
		/**
		* POST /mode 的请求体。模式本身不放 localStorage（服务端按会话存）。
		* project 只是顺手带上：服务端现在的 /mode 分支排在 project 校验之后，不带会被 400 打回。
		*/
		function modeRequestBody(sessionId, mode, project) {
			const body = {
				sessionId,
				mode
			};
			if (typeof project === "string" && project !== "") body.project = project;
			return body;
		}
		/** 读响应里的模式值（错误体没有 mode）。 */
		function parseMode(j) {
			return normalizeMode(j.mode);
		}
		const STATUS_COLOR = {
			planned: "#94a3b8",
			ready: "#3b82f6",
			doing: "#f59e0b",
			blocked: "#ef4444",
			done: "#10b981",
			canceled: "#6b7280"
		};
		/**
		* 宿主主区面板 id。
		*
		* main 是 keyed 槽（key = 面板 id），sidebar.panellist 是 list 槽（id = 同一个面板 id）：
		* 宿主靠这个 id 把侧栏图标和主区面板对上（layout.selectPanel 找不到同名的 main 面板会抛
		* "main panel X is not registered"），所以两处必须同一个字符串。
		* 它与引擎的 'dsh-superagent'、旧插件的 'dsh-plan-board' 都不撞，全宿主唯一。
		*/
		const PANEL_ID = NS;
		/** 侧栏图标的显示名（locale 字典；zh/en 同名，PlanBoard 是产品名不翻译）。 */
		const LOCALE_DICT = {
			zh: { panel: "PlanBoard" },
			en: { panel: "PlanBoard" }
		};
		/** 主题跟随：采样 app body 实际背景亮度；异常时退回系统偏好。 */
		function appDark() {
			try {
				const bg = getComputedStyle(document.body).backgroundColor;
				const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
				if (m != null) return (.299 * Number(m[1]) + .587 * Number(m[2]) + .114 * Number(m[3])) / 255 < .5;
			} catch {}
			return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
		}
		const CSS = [
			".pb-panel{--pb-bg:#f8fafc;--pb-ink:#0f172a;--pb-line:#e2e8f0;--pb-card:#ffffff;--pb-muted:#64748b;",
			"position:relative;width:100%;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;",
			"background:var(--pb-bg);color:var(--pb-ink);border-left:1px solid var(--pb-line)}",
			".pb-panel[data-collapsed] .pb-body{display:none}",
			".pb-panel[data-mode=\"dark\"]{--pb-bg:#0f141c;--pb-ink:#e2e8f0;--pb-line:#1e293b;--pb-card:#151b26;--pb-muted:#7c8798}",
			".pb-head{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--pb-line)}",
			".pb-title{font-weight:700;font-size:13px;letter-spacing:.4px}",
			".pb-input{flex:1;min-width:0;font:12px/1.4 ui-monospace,monospace;padding:5px 8px;border-radius:8px;",
			"border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-ink)}",
			".pb-btn{cursor:pointer;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:600;",
			"border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-ink)}",
			".pb-btn:hover{filter:brightness(1.08)}",
			".pb-btn.pb-ok{background:#10b981;border-color:#10b981;color:#fff}",
			".pb-btn.pb-no{background:#ef4444;border-color:#ef4444;color:#fff}",
			".pb-btn.pb-vio{background:#8b5cf6;border-color:#8b5cf6;color:#fff}",
			".pb-btn:disabled{opacity:.5;cursor:not-allowed}",
			".pb-body{flex:1;min-height:0;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}",
			".pb-banner{padding:8px 12px;border-radius:10px;font-size:12px;font-weight:600;display:flex;gap:8px;align-items:center}",
			".pb-banner.pb-drift{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.5);color:#ef4444}",
			".pb-banner.pb-appr{background:rgba(245,158,11,.10);border:1px solid rgba(245,158,11,.45);color:#b45309}",
			"[data-mode=\"dark\"] .pb-banner.pb-appr{color:#fbbf24}",
			".pb-banner.pb-guard{background:rgba(139,92,246,.10);border:1px solid rgba(139,92,246,.5);color:#7c3aed}",
			"[data-mode=\"dark\"] .pb-banner.pb-guard{color:#a78bfa}",
			".pb-banner.pb-hold{background:rgba(100,116,139,.10);border:1px dashed rgba(100,116,139,.55);color:#64748b}",
			"[data-mode=\"dark\"] .pb-banner.pb-hold{color:#94a3b8}",
			".pb-banner.pb-dirty{background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.6);color:#b45309;position:sticky;top:0;z-index:5}",
			"[data-mode=\"dark\"] .pb-banner.pb-dirty{color:#fbbf24}",
			".pb-card{background:var(--pb-card);border:1px solid var(--pb-line);border-radius:10px;padding:8px 10px;font-size:12px}",
			".pb-sec{font-size:11px;font-weight:700;letter-spacing:1px;color:var(--pb-muted);text-transform:uppercase}",
			".pb-ev{display:flex;gap:8px;font:11px ui-monospace,monospace;color:var(--pb-muted);padding:1px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".pb-station{animation:pb-pulse 1.6s ease-in-out infinite}",
			"@keyframes pb-pulse{0%,100%{opacity:.35}50%{opacity:1}}",
			".pb-map{flex:0 0 auto;background:var(--pb-card);border:1px solid var(--pb-line);border-radius:12px;overflow:hidden;cursor:grab}",
			".pb-map text{font-family:ui-sans-serif,system-ui,sans-serif;fill:var(--pb-ink,#0f172a)}",
			".pb-node{cursor:grab}",
			".pb-node.pb-dragging{cursor:grabbing}",
			".pb-handle{cursor:crosshair}",
			".pb-hint{font-size:11px;color:var(--pb-muted);line-height:1.6}",
			".pb-form{display:flex;flex-direction:column;gap:8px}",
			".pb-form label{display:flex;flex-direction:column;gap:3px;font-size:11px;font-weight:600;color:var(--pb-muted)}",
			".pb-form input,.pb-form textarea,.pb-form select{font:12px/1.5 ui-sans-serif,system-ui,sans-serif;padding:5px 8px;border-radius:8px;",
			"border:1px solid var(--pb-line);background:var(--pb-bg);color:var(--pb-ink)}",
			".pb-form textarea{min-height:44px;resize:vertical;font:12px/1.5 ui-monospace,monospace}",
			".pb-deprow{display:flex;align-items:center;gap:6px;font-size:12px;padding:2px 0}",
			".pb-dot{width:6px;height:6px;border-radius:50%;background:#f59e0b;display:inline-block}",
			"position:relative;display:inline-flex;align-items:center;gap:0;box-sizing:border-box;height:31px;padding:0 5.5px;",
			"border-radius:15.5px;cursor:pointer;overflow:hidden;user-select:none;vertical-align:middle;line-height:1;",
			"font-size:12.5px;font-weight:600;letter-spacing:.2px;color:#f3f7ff;border:1px solid transparent;",
			"background:linear-gradient(135deg,#080b14 0%,#0b0918 55%,#120a20 100%) padding-box,linear-gradient(112deg,#22d3ee 0%,#38bdf8 24%,#8b5cf6 58%,#e879f9 100%) border-box;",
			"box-shadow:0 0 0 1px rgba(139,92,246,.20),0 2px 12px rgba(56,189,248,.30),0 2px 18px rgba(232,121,249,.24),inset 0 0 14px rgba(124,58,237,.35),inset 0 1px 0 rgba(255,255,255,.07);",
			"transition:transform .16s cubic-bezier(.34,1.56,.64,1),box-shadow .28s,filter .28s,padding var(--pb-dur) var(--pb-ease),border-radius var(--pb-dur) var(--pb-ease)}",
			"background:radial-gradient(58% 120% at 12% 18%,rgba(34,211,238,.36),transparent 62%),radial-gradient(52% 128% at 88% 30%,rgba(232,121,249,.32),transparent 64%),radial-gradient(72% 140% at 50% 128%,rgba(139,92,246,.32),transparent 66%)}",
			"background:conic-gradient(from 0deg,transparent 0 40%,rgba(34,211,238,.95) 58%,rgba(139,92,246,1) 72%,rgba(232,121,249,.95) 86%,transparent 100%);",
			"-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;",
			"mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}",
			"@keyframes pb-ring-spin{to{transform:rotate(360deg)}}",
			"background:linear-gradient(100deg,transparent,rgba(255,255,255,.55),transparent);transform:skewX(-18deg)}",
			"@keyframes pb-shine{0%{left:-65%;opacity:.9}100%{left:135%;opacity:0}}",
			"transition:transform .2s cubic-bezier(.34,1.56,.64,1)}",
			"@keyframes pb-core{0%,100%{transform:scale(1);opacity:.92}50%{transform:scale(1.18);opacity:1}}",
			"@keyframes pb-dash{to{stroke-dashoffset:-14}}",
			"@keyframes pb-sat{0%,100%{transform:scale(.72);opacity:.5}50%{transform:scale(1.15);opacity:1}}",
			"opacity:0;transition:opacity .25s,background .25s,box-shadow .25s}",
			"@keyframes pb-dot{0%,100%{opacity:1}50%{opacity:.45}}",
			"box-shadow:0 0 0 1px rgba(168,85,247,.45),0 6px 26px rgba(124,58,237,.55),0 0 26px rgba(56,189,248,.40),0 0 30px rgba(232,121,249,.32),inset 0 0 18px rgba(124,58,237,.45)}",
			"box-shadow:0 1px 6px rgba(99,102,241,.4),inset 0 1px 0 rgba(255,255,255,.12)}",
			"@keyframes pb-aurora{0%,100%{opacity:.8;filter:saturate(1)}50%{opacity:1;filter:saturate(1.35)}}",
			".pb-projrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 12px;border-bottom:1px solid var(--pb-line);font-size:11px;color:var(--pb-muted)}",
			".pb-projpath{font-family:ui-monospace,monospace;font-size:11px;color:var(--pb-ink);cursor:pointer;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".pb-tag{cursor:pointer;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid var(--pb-line);background:var(--pb-card);color:var(--pb-muted);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".pb-tag.pb-on{border-color:#8b5cf6;color:#7c3aed;background:rgba(139,92,246,.12)}",
			"[data-mode=\"dark\"] .pb-tag.pb-on{color:#a78bfa}",
			".pb-tag:hover{filter:brightness(1.08)}",
			".pb-modewrap{display:inline-flex;align-items:center;flex:0 0 auto;gap:0}",
			".pb-modebtn{cursor:pointer;width:20px;height:20px;min-width:20px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;",
			"padding:0;border-radius:999px;border:1px solid transparent;background:transparent;color:inherit;opacity:.7}",
			".pb-modebtn:hover{opacity:1;background:rgba(139,92,246,.14)}",
			".pb-modebtn:focus-visible{outline:2px solid rgba(139,92,246,.7);outline-offset:1px}",
			".pb-modebtn.pb-on{background:#8b5cf6;border-color:#8b5cf6;color:#fff;opacity:1;box-shadow:0 0 0 1px rgba(139,92,246,.3)}",
			".pb-modebtn.pb-err{border-color:#ef4444}",
			".pb-modebtn:disabled{opacity:.35;cursor:not-allowed}",
			".pb-ops{border:1px dashed var(--pb-line);border-radius:8px;padding:6px;margin:6px 0;display:flex;flex-direction:column;gap:6px;background:rgba(100,116,139,.05)}",
			".pb-oprow{border:1px solid var(--pb-line);border-radius:8px;padding:6px;display:flex;flex-direction:column;gap:5px;background:var(--pb-card)}",
			".pb-ophead{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:var(--pb-muted)}",
			".pb-chip{font:10px/1.4 ui-monospace,monospace;padding:1px 6px;border-radius:999px;background:rgba(139,92,246,.12);color:#7c3aed}",
			"[data-mode=\"dark\"] .pb-chip{color:#a78bfa}",
			".pb-oplabel{display:flex;flex-direction:column;gap:2px;font-size:10px;font-weight:600;color:var(--pb-muted)}",
			".pb-oplabel input,.pb-oplabel textarea,.pb-oplabel select{font:11px/1.5 ui-sans-serif,system-ui,sans-serif;padding:3px 6px;border-radius:6px;border:1px solid var(--pb-line);background:var(--pb-bg);color:var(--pb-ink)}",
			".pb-oplabel textarea{min-height:38px;resize:vertical;font:11px/1.5 ui-monospace,monospace}",
			".pb-deps{display:flex;flex-direction:column;gap:2px;max-height:150px;overflow:auto;border:1px solid var(--pb-line);border-radius:6px;padding:4px;background:var(--pb-bg)}",
			".pb-deps .pb-deprow{font-size:11px}",
			".pb-cycle{font-size:11px;font-weight:700;color:#ef4444;line-height:1.5}",
			".pb-crash{padding:14px;border:1px solid rgba(239,68,68,.5);border-radius:10px;background:rgba(239,68,68,.08);display:flex;flex-direction:column;gap:8px;font-size:12px;color:inherit}",
			".pb-crash-title{font-weight:700;color:#ef4444;font-size:13px}",
			".pb-crash-msg{opacity:.85;line-height:1.6}",
			".pb-crash-btn{cursor:pointer;align-self:flex-start;padding:5px 12px;border-radius:8px;font-size:12px;font-weight:600;border:1px solid #ef4444;background:#ef4444;color:#fff}",
			".pb-designbar{display:flex;align-items:center;gap:8px;margin-top:2px}",
			".pb-design{border:1px dashed var(--pb-line);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:8px;background:rgba(100,116,139,.05)}",
			".pb-designsteps{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px}",
			".pb-designsteps li{display:flex;gap:6px;align-items:center}",
			".pb-designsteps input{flex:1;min-width:0;font:11px/1.5 ui-monospace,monospace;padding:3px 6px;border-radius:6px;border:1px solid var(--pb-line);background:var(--pb-bg);color:var(--pb-ink)}",
			".pb-designextra{font:10px/1.4 ui-monospace,monospace;color:var(--pb-muted);white-space:pre-wrap;word-break:break-all;background:var(--pb-bg);border:1px solid var(--pb-line);border-radius:6px;padding:4px 6px;max-height:120px;overflow:auto}"
		].join("\n");
		function ensureStyles() {
			if (document.getElementById("dsh-plan-superagent-css") != null) return;
			const el = document.createElement("style");
			el.id = "dsh-plan-superagent-css";
			el.textContent = CSS;
			document.head.appendChild(el);
		}
		/** Register the project the panel is on, so the bridge can follow it even before it has a board. */
		async function rememberProject(path) {
			const value = path.trim();
			if (value === "") return;
			try {
				await post("/remember", {
					project: value,
					name: value
				});
			} catch {}
		}
		async function post(path, body) {
			return await (await fetch(API + path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			})).json();
		}
		/** 客户端环检测（保存前快失败；服务端 lint 仍兜底）。 */
		function hasCycle(nodes) {
			const byId = new Map(nodes.map((n) => [n.id, n]));
			const color = /* @__PURE__ */ new Map();
			const dfs = (id) => {
				const c = color.get(id);
				if (c === 1) return true;
				if (c === 2) return false;
				color.set(id, 1);
				for (const d of byId.get(id)?.deps ?? []) if (byId.has(d) && dfs(d)) return true;
				color.set(id, 2);
				return false;
			};
			for (const n of nodes) if (dfs(n.id)) return true;
			return false;
		}
		const ROW = 30;
		const MOD_H = 42;
		function MindMap(props) {
			const { data, effNodes, layout, dirtyIds, view, setView, dragRef, depLine, setDepLine, editorId, onNodePointerDown, onNodeMove, onNodeClick, onDepDrop, onHandlePointerDown, svgRef } = props;
			const drag = (0, react.useRef)(null);
			const b = data.board;
			const mods = (0, react.useMemo)(() => effNodes.filter((n) => n.type === "module"), [effNodes]);
			const posOf = (id) => layout.items.find((i) => i.node.id === id);
			const toSvg = (clientX, clientY) => {
				const rect = svgRef.current?.getBoundingClientRect();
				const left = rect?.left ?? 0;
				const top = rect?.top ?? 0;
				return {
					x: (clientX - left - view.tx) / view.k,
					y: (clientY - top - view.ty) / view.k
				};
			};
			const edge = (a, bx, by) => {
				const x1 = a.x + a.w;
				const y1 = a.y + a.h / 2;
				const mx = (x1 + bx) / 2;
				return "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + by + ", " + bx + " " + by;
			};
			const depEdge = (a, bp) => {
				const x1 = a.x - 6;
				const y1 = a.y + a.h / 2;
				const x2 = bp.x - 6;
				const y2 = bp.y + bp.h / 2;
				const mx = Math.min(x1, x2) - 46;
				return "M " + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2;
			};
			const mapRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const el = mapRef.current;
				if (el == null) return;
				const onWheel = (e) => {
					if (!e.ctrlKey && !e.metaKey) return;
					e.preventDefault();
					setView((v) => ({
						...v,
						k: Math.min(2.2, Math.max(.35, v.k * (e.deltaY > 0 ? .92 : 1.08)))
					}));
				};
				el.addEventListener("wheel", onWheel, { passive: false });
				return () => el.removeEventListener("wheel", onWheel);
			}, [setView]);
			return (0, react.createElement)("div", {
				className: "pb-map",
				ref: mapRef,
				onPointerDown: (e) => {
					if (dragRef.current != null) return;
					drag.current = {
						x: e.clientX,
						y: e.clientY,
						tx: view.tx,
						ty: view.ty
					};
					try {
						e.target.setPointerCapture?.(e.pointerId);
					} catch {}
				},
				onPointerMove: (e) => {
					const d = dragRef.current;
					if (d != null && d.kind === "node") {
						const p = toSvg(e.clientX, e.clientY);
						if (Math.abs(p.x - d.sx) * view.k > 3 || Math.abs(p.y - d.sy) * view.k > 3) d.moved = true;
						onNodeMove(d.id, {
							x: d.bx + (p.x - d.sx),
							y: d.by + (p.y - d.sy)
						});
						return;
					}
					if (d != null && d.kind === "dep") {
						const p = toSvg(e.clientX, e.clientY);
						const f = posOf(d.from);
						if (f != null) setDepLine({
							x1: f.x + f.w,
							y1: f.y + f.h / 2,
							x2: p.x,
							y2: p.y
						});
						return;
					}
					const base = drag.current;
					if (base == null) return;
					setView((v) => ({
						...v,
						tx: base.tx + (e.clientX - base.x),
						ty: base.ty + (e.clientY - base.y)
					}));
				},
				onPointerUp: (e) => {
					const d = dragRef.current;
					dragRef.current = null;
					setDepLine(null);
					drag.current = null;
					if (d != null && d.kind === "node") {
						if (!d.moved) onNodeClick(d.id);
						return;
					}
					if (d != null && d.kind === "dep") {
						onDepDrop(d.from, {
							clientX: e.clientX,
							clientY: e.clientY
						});
						return;
					}
				},
				onPointerCancel: () => {
					drag.current = null;
					dragRef.current = null;
					setDepLine(null);
				},
				onPointerLeave: () => {
					drag.current = null;
					dragRef.current = null;
					setDepLine(null);
				},
				onLostPointerCapture: () => {
					drag.current = null;
					dragRef.current = null;
					setDepLine(null);
				}
			}, (0, react.createElement)("svg", {
				width: "100%",
				height: Math.max(layout.totalH, 300),
				ref: svgRef,
				key: b.version
			}, (0, react.createElement)("g", { transform: "translate(" + view.tx + "," + view.ty + ") scale(" + view.k + ")" }, effNodes.filter((n) => n.type === "module" && n.parent == null).map((m, i) => {
				const rp = posOf("__root__");
				const mp = posOf(m.id);
				if (rp == null || mp == null) return null;
				return (0, react.createElement)("path", {
					key: "e" + i,
					d: edge(rp, mp.x, mp.y + mp.h / 2),
					stroke: "var(--pb-line,#cbd5e1)",
					strokeWidth: 1.6,
					fill: "none"
				});
			}), mods.map((m, mi) => {
				const mp = posOf(m.id);
				if (mp == null) return null;
				return (0, react.createElement)("g", { key: "mg" + mi }, effNodes.filter((t) => t.type === "task" && t.parent === m.id).map((t, ti) => {
					const tp = posOf(t.id);
					if (tp == null) return null;
					return (0, react.createElement)("path", {
						key: "te" + mi + "_" + ti,
						d: edge(mp, tp.x, tp.y + tp.h / 2),
						stroke: "var(--pb-line,#cbd5e1)",
						strokeWidth: 1.2,
						fill: "none"
					});
				}));
			}), effNodes.flatMap((t, di) => (t.deps ?? []).map((d, dj) => {
				const a = posOf(t.id);
				const bp = posOf(d);
				if (a == null || bp == null) return null;
				return (0, react.createElement)("path", {
					key: "dep" + di + "_" + dj,
					d: depEdge(bp, a),
					stroke: "#8b5cf6",
					strokeWidth: 1.3,
					strokeDasharray: "5 4",
					fill: "none",
					opacity: .8
				});
			})), depLine != null ? (0, react.createElement)("line", {
				x1: depLine.x1,
				y1: depLine.y1,
				x2: depLine.x2,
				y2: depLine.y2,
				stroke: "#8b5cf6",
				strokeWidth: 2,
				strokeDasharray: "4 3",
				opacity: .9
			}) : null, layout.items.map((it, ii) => {
				const isRoot = it.node.id === "__root__";
				const color = STATUS_COLOR[it.node.status] ?? "#94a3b8";
				const ord = data.order[it.node.id];
				const isStation = it.node.id === data.station;
				const isEditor = it.node.id === editorId;
				const isDirty = dirtyIds.has(it.node.id);
				if (isRoot) return (0, react.createElement)("g", { key: "n" + ii }, (0, react.createElement)("rect", {
					x: it.x,
					y: it.y,
					width: it.w,
					height: it.h,
					rx: 12,
					fill: "var(--pb-bg)",
					stroke: color,
					strokeWidth: 2
				}), (0, react.createElement)("rect", {
					x: it.x,
					y: it.y,
					width: 4,
					height: it.h,
					rx: 2,
					fill: color
				}), (0, react.createElement)("text", {
					x: it.x + 12,
					y: it.y + it.h / 2 + 4,
					fontSize: 13,
					fontWeight: 600
				}, it.node.title.slice(0, 26)));
				return (0, react.createElement)("g", {
					key: "n" + it.node.id,
					className: "pb-node",
					"data-id": it.node.id,
					onPointerDown: (e) => {
						e.stopPropagation();
						onNodePointerDown(e, it.node.id, {
							x: it.x,
							y: it.y
						});
					}
				}, isStation ? (0, react.createElement)("rect", {
					className: "pb-station",
					x: it.x - 4,
					y: it.y - 4,
					width: it.w + 8,
					height: it.h + 8,
					rx: 12,
					fill: "none",
					stroke: "#f59e0b",
					strokeWidth: 2
				}) : null, isEditor ? (0, react.createElement)("rect", {
					x: it.x - 6,
					y: it.y - 6,
					width: it.w + 12,
					height: it.h + 12,
					rx: 12,
					fill: "none",
					stroke: "#8b5cf6",
					strokeWidth: 2,
					strokeDasharray: "6 3"
				}) : null, (0, react.createElement)("rect", {
					x: it.x,
					y: it.y,
					width: it.w,
					height: it.h,
					rx: 9,
					fill: "var(--pb-bg)",
					stroke: isEditor ? "#8b5cf6" : color,
					strokeWidth: 1.5
				}), (0, react.createElement)("rect", {
					x: it.x,
					y: it.y,
					width: 4,
					height: it.h,
					rx: 2,
					fill: color
				}), (0, react.createElement)("text", {
					x: it.x + 12,
					y: it.y + it.h / 2 + 4,
					fontSize: 12,
					fontWeight: 600
				}, (ord != null ? "#" + ord + " " : "") + (isDirty ? "● " : "") + it.node.title.slice(0, 24)), it.node.type === "task" ? (0, react.createElement)("text", {
					x: it.x + it.w - 8,
					y: it.y + it.h / 2 + 4,
					fontSize: 10,
					textAnchor: "end",
					fill: color
				}, it.node.status) : null, it.node.type === "task" ? (0, react.createElement)("circle", {
					className: "pb-handle",
					cx: it.x + it.w + 6,
					cy: it.y + it.h / 2,
					r: 5,
					fill: "#8b5cf6",
					opacity: .85,
					title: "拖到目标任务 = 目标依赖此任务；再拖一次 = 移除依赖",
					onPointerDown: (e) => {
						e.stopPropagation();
						onHandlePointerDown(e, it.node.id);
					}
				}) : null);
			}))));
		}
		/** 依赖多选（候选项来自板子节点 + 同提案新增的节点）。 */
		function DepPicker(props) {
			const { options, value, onChange } = props;
			return (0, react.createElement)("div", { className: "pb-deps" }, options.length === 0 ? (0, react.createElement)("span", { className: "pb-hint" }, "（暂无可选依赖节点）") : null, options.map((o) => (0, react.createElement)("label", {
				className: "pb-deprow",
				key: o.id
			}, (0, react.createElement)("input", {
				type: "checkbox",
				checked: value.includes(o.id),
				onChange: (e) => {
					const arr = value.slice();
					const i = arr.indexOf(o.id);
					if (e.target.checked && i < 0) arr.push(o.id);
					if (!e.target.checked && i >= 0) arr.splice(i, 1);
					onChange(arr);
				}
			}), (0, react.createElement)("span", {}, o.id + " · " + clip(o.title, 26)))));
		}
		/**
		* 待批提案卡：把 ops 摊开成可编辑的行。
		* 用户真正的痛点是「一句话生成的导图没法手改」—— 以前只能确认/驳回，现在能改标题、验收、scope、
		* 依赖、优先级，能删掉某条 op（= 不创建那个节点），改完再把改过的 ops 一起提交。
		*/
		function ApprovalCard(props) {
			const { ap, ops, origOps, dirty, cycle, issues, options, busy, rev, onOps, onReset, onApprove, onReject } = props;
			const patch = (i, next) => {
				onOps(ops.map((o, k) => k === i ? next : o));
			};
			const patchNode = (i, p) => {
				const o = ops[i];
				if (o == null || o.op !== "add_node") return;
				patch(i, {
					...o,
					node: {
						...o.node,
						...p
					}
				});
			};
			const patchFields = (i, p) => {
				const o = ops[i];
				if (o == null || o.op !== "update_node") return;
				patch(i, {
					...o,
					fields: {
						...o.fields,
						...p
					}
				});
			};
			const dropOp = (i) => {
				onOps(ops.filter((_, k) => k !== i));
			};
			const lbl = (text, ctrl) => (0, react.createElement)("label", { className: "pb-oplabel" }, text, ctrl);
			const prio = (cur, onChange) => (0, react.createElement)("select", {
				value: String(cur ?? 3),
				onChange: (e) => onChange(Number(e.target.value))
			}, [
				1,
				2,
				3,
				4,
				5
			].map((p) => (0, react.createElement)("option", {
				key: p,
				value: String(p)
			}, "P" + p)));
			const delBtn = (i) => (0, react.createElement)("button", {
				className: "pb-btn",
				style: { marginLeft: "auto" },
				onClick: () => dropOp(i)
			}, "删除此条");
			const rows = ops.map((op, i) => {
				if (op.op === "init_board") {
					const nameVal = op.name;
					const goalVal = op.goal;
					return (0, react.createElement)("div", {
						className: "pb-oprow",
						key: "op" + i
					}, (0, react.createElement)("div", { className: "pb-ophead" }, (0, react.createElement)("span", { className: "pb-chip" }, "init_board"), delBtn(i)), lbl("计划名", (0, react.createElement)("input", {
						value: nameVal,
						onChange: (e) => patch(i, {
							...op,
							name: e.target.value
						})
					})), lbl("目标", (0, react.createElement)("textarea", {
						key: "goal" + rev,
						defaultValue: goalVal,
						onChange: (e) => patch(i, {
							...op,
							goal: e.target.value
						})
					})));
				}
				if (op.op === "add_node") {
					const n = op.node;
					return (0, react.createElement)("div", {
						className: "pb-oprow",
						key: "op" + i
					}, (0, react.createElement)("div", { className: "pb-ophead" }, (0, react.createElement)("span", { className: "pb-chip" }, "add_node"), (0, react.createElement)("span", { className: "pb-chip" }, n.type === "task" ? "任务" : "模块"), (0, react.createElement)("span", { className: "pb-chip" }, n.id), delBtn(i)), lbl("标题", (0, react.createElement)("input", {
						value: n.title,
						onChange: (e) => patchNode(i, { title: e.target.value })
					})), lbl("验收标准（每行一条）", (0, react.createElement)("textarea", {
						key: "acc" + rev,
						defaultValue: n.acceptance.join("\n"),
						onChange: (e) => patchNode(i, { acceptance: splitLines(e.target.value) })
					})), lbl("scope（每行一条，目录以 / 结尾）", (0, react.createElement)("textarea", {
						key: "scope" + rev,
						defaultValue: n.scope.join("\n"),
						onChange: (e) => patchNode(i, { scope: splitLines(e.target.value) })
					})), lbl("优先级", prio(n.priority, (v) => patchNode(i, { priority: v }))), (0, react.createElement)("div", { className: "pb-oplabel" }, "依赖（前置节点，可多选）", (0, react.createElement)(DepPicker, {
						options: options.filter((o) => o.id !== n.id),
						value: n.deps,
						onChange: (v) => patchNode(i, { deps: v })
					})));
				}
				if (op.op === "update_node") {
					const f = op.fields;
					const titleVal = typeof f.title === "string" ? f.title : null;
					const noteVal = typeof f.note === "string" ? f.note : null;
					const accVal = Array.isArray(f.acceptance) ? f.acceptance : null;
					const scopeVal = Array.isArray(f.scope) ? f.scope : null;
					const prioVal = typeof f.priority === "number" ? f.priority : null;
					const depsVal = Array.isArray(f.deps) ? f.deps : null;
					return (0, react.createElement)("div", {
						className: "pb-oprow",
						key: "op" + i
					}, (0, react.createElement)("div", { className: "pb-ophead" }, (0, react.createElement)("span", { className: "pb-chip" }, "update_node"), (0, react.createElement)("span", { className: "pb-chip" }, op.id), delBtn(i)), titleVal != null ? lbl("标题", (0, react.createElement)("input", {
						value: titleVal,
						onChange: (e) => patchFields(i, { title: e.target.value })
					})) : null, noteVal != null ? lbl("备注（生成器写的是子导图指针，改坏了子导图就找不到）", (0, react.createElement)("textarea", {
						key: "unote" + rev,
						defaultValue: noteVal,
						onChange: (e) => patchFields(i, { note: e.target.value })
					})) : null, accVal != null ? lbl("验收标准（每行一条）", (0, react.createElement)("textarea", {
						key: "uacc" + rev,
						defaultValue: accVal.join("\n"),
						onChange: (e) => patchFields(i, { acceptance: splitLines(e.target.value) })
					})) : null, scopeVal != null ? lbl("scope（每行一条）", (0, react.createElement)("textarea", {
						key: "uscope" + rev,
						defaultValue: scopeVal.join("\n"),
						onChange: (e) => patchFields(i, { scope: splitLines(e.target.value) })
					})) : null, prioVal != null ? lbl("优先级", prio(prioVal, (v) => patchFields(i, { priority: v }))) : null, depsVal != null ? (0, react.createElement)("div", { className: "pb-oplabel" }, "依赖（可多选）", (0, react.createElement)(DepPicker, {
						options: options.filter((o) => o.id !== op.id),
						value: depsVal,
						onChange: (v) => patchFields(i, { deps: v })
					})) : null);
				}
				if (op.op === "remove_node") return (0, react.createElement)("div", {
					className: "pb-oprow",
					key: "op" + i
				}, (0, react.createElement)("div", { className: "pb-ophead" }, (0, react.createElement)("span", { className: "pb-chip" }, "remove_node"), (0, react.createElement)("span", { className: "pb-chip" }, op.id), delBtn(i)), (0, react.createElement)("div", { className: "pb-hint" }, "生效后会移除节点 " + op.id));
				return (0, react.createElement)("div", {
					className: "pb-oprow",
					key: "op" + i
				}, (0, react.createElement)("div", { className: "pb-ophead" }, (0, react.createElement)("span", { className: "pb-chip" }, "set_deps"), (0, react.createElement)("span", { className: "pb-chip" }, op.id), delBtn(i)), (0, react.createElement)("div", { className: "pb-oplabel" }, "依赖（可多选）", (0, react.createElement)(DepPicker, {
					options: options.filter((o) => o.id !== op.id),
					value: op.deps,
					onChange: (v) => patch(i, {
						...op,
						deps: v
					})
				})));
			});
			return (0, react.createElement)("div", { className: "pb-card" }, (0, react.createElement)("div", { style: {
				fontWeight: 700,
				marginBottom: "4px"
			} }, ap.id + " · " + ops.length + " ops · " + ap.by), (0, react.createElement)("div", { style: {
				opacity: .8,
				marginBottom: "6px"
			} }, ap.reason), (0, react.createElement)("div", { className: "pb-ops" }, rows.length === 0 ? (0, react.createElement)("div", { className: "pb-hint" }, "（这条提案的操作都被你删了 —— 批准它等于什么都不做）") : rows), cycle !== "" ? (0, react.createElement)("div", { className: "pb-cycle" }, "⛔ 依赖会成环：" + cycle + "（先去掉其中一条再批准）") : null, issues.map((x, i) => (0, react.createElement)("div", {
				className: "pb-cycle",
				key: "iss" + i
			}, "⚠ " + x)), (0, react.createElement)("div", { style: {
				display: "flex",
				gap: "8px",
				alignItems: "center",
				marginTop: "6px",
				flexWrap: "wrap"
			} }, (0, react.createElement)("button", {
				className: "pb-btn pb-ok",
				disabled: busy || cycle !== "",
				onClick: onApprove
			}, dirty ? "确认生效（按你的修改）" : "确认生效"), (0, react.createElement)("button", {
				className: "pb-btn pb-no",
				disabled: busy,
				onClick: onReject
			}, "驳回"), (0, react.createElement)("button", {
				className: "pb-btn",
				disabled: busy || !dirty,
				onClick: onReset
			}, "重置为原提案"), (0, react.createElement)("span", { className: "pb-hint" }, dirty ? "已修改（原 " + origOps.length + " 条 → 现 " + ops.length + " 条）" : "未修改")));
		}
		/**
		* 计划板模式开关：挂在宿主输入栏左侧（conversation.input.left 插槽，与权限/计划芯片同一排）。
		* 状态按会话存在服务端：挂载时 GET /mode 读回，点一下 POST /mode 切。
		* 失败只在按钮旁显示一行小字 —— 输入栏旁边弹 alert 会吓人。
		*/
		function PlanBoardModeChip(props) {
			ensureStyles();
			const [mode, setMode] = (0, react.useState)("direct");
			const [busy, setBusy] = (0, react.useState)(false);
			const [err, setErr] = (0, react.useState)("");
			const sid = resolveSessionId(props.sessionId);
			(0, react.useEffect)(() => {
				if (sid == null) return;
				let stop = false;
				(async () => {
					try {
						const j = await readJson(await fetch(API + "/mode?sessionId=" + encodeURIComponent(sid)));
						if (stop) return;
						const m = parseMode(j);
						if (m != null) setMode(m);
						else setErr(errText(j.error));
					} catch (e) {
						if (!stop) setErr(String(e));
					}
				})();
				return () => {
					stop = true;
				};
			}, [sid]);
			const toggle = async () => {
				if (busy || sid == null) return;
				const target = nextMode(mode);
				setBusy(true);
				setErr("");
				try {
					const j = await post("/mode", modeRequestBody(sid, target, loadProject()));
					if (j.ok !== true) {
						setErr(errText(j.error));
						return;
					}
					const m = parseMode(j);
					if (m != null) setMode(m);
				} catch (e) {
					setErr(String(e));
				} finally {
					setBusy(false);
				}
			};
			const tip = sid == null ? "计划板模式：拿不到会话 id，开关不可用" : mode === "plan" ? "计划板模式：开 —— 开发类需求先出计划树再动手（点击关掉）" : "计划板模式：关 —— 点击开启：开发类需求先出计划树再动手";
			return (0, react.createElement)("span", { className: "pb-modewrap" }, (0, react.createElement)("button", {
				className: "pb-modebtn" + (mode === "plan" ? " pb-on" : "") + (err !== "" ? " pb-err" : ""),
				disabled: busy || sid == null,
				"aria-pressed": mode === "plan",
				"aria-label": modeLabel(mode),
				title: err !== "" ? modeLabel(mode) + "｜" + err : tip,
				onClick: (e) => {
					e.currentTarget.blur();
					toggle();
				}
			}, (0, react.createElement)("svg", {
				viewBox: "0 0 16 16",
				width: 13,
				height: 13,
				"aria-hidden": "true"
			}, (0, react.createElement)("rect", {
				x: 2.2,
				y: 2.6,
				width: 11.6,
				height: 10.8,
				rx: 2.4,
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4
			}), (0, react.createElement)("path", {
				d: "M4.8 6.3h6.4M4.8 9.2h4.2",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round"
			}))));
		}
		/**
		* 侧栏面板图标：宿主按面板大小传 size（16/18），颜色跟主题走 currentColor。
		* 不加文字、不加外框 —— 侧栏那一列都是小图标，板只是其中一个。
		*/
		function PanelBoardIcon(props) {
			const size = props.size ?? 18;
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true"
			}, (0, react.createElement)("rect", {
				x: 3.5,
				y: 4,
				width: 17,
				height: 16,
				rx: 2.5
			}), (0, react.createElement)("path", { d: "M3.5 9.2h17" }), (0, react.createElement)("path", { d: "M9.2 9.2V20" }), (0, react.createElement)("path", { d: "M12.8 13.2h4.4M12.8 16.6h4.4" }));
		}
		/**
		* 面板自己的错误边界。
		* 宿主虽然有 SlotErrorBoundary，但它的崩溃面是**空 div**，而且会把条目永久退役（abdicate）
		* → 用户只看到一块空白、没有出口。这里自己接住：一句人话提示 + 一个"重新加载面板"按钮。
		*/
		var PanelBoundary = class extends react.Component {
			state = { error: null };
			componentDidCatch(error) {
				console.error("[dsh-plan-superagent] 面板渲染异常：", error);
				this.setState({ error });
			}
			render() {
				const err = this.state.error;
				if (err != null) return (0, react.createElement)("div", { className: "pb-crash" }, (0, react.createElement)("div", { className: "pb-crash-title" }, "面板出错了"), (0, react.createElement)("div", { className: "pb-crash-msg" }, "这一次的渲染抛了异常，导图与编辑卡先停在这里。" + (err.message !== "" ? "（" + clip(err.message, 140) + "）" : "")), (0, react.createElement)("button", {
					className: "pb-crash-btn",
					onClick: () => {
						this.setState({ error: null });
						this.props.onReset();
					}
				}, "重新加载面板"));
				return this.props.children ?? null;
			}
		};
		/** 面板外壳：错误边界 + 重挂载（崩了能自己回来，而不是留一块空白）。 */
		function PanelHost(props) {
			const [gen, setGen] = (0, react.useState)(0);
			return (0, react.createElement)(PanelBoundary, { onReset: () => setGen((g) => g + 1) }, (0, react.createElement)("div", {
				key: gen,
				style: { display: "contents" }
			}, (0, react.createElement)(PaneWindow, props)));
		}
		function PaneWindow() {
			const [collapsed, setCollapsed] = (0, react.useState)(false);
			const [project, setProject] = (0, react.useState)(loadProject());
			const [data, setData] = (0, react.useState)(null);
			const [err, setErr] = (0, react.useState)("");
			const [nonce, setNonce] = (0, react.useState)(0);
			const [mode, setMode] = (0, react.useState)(appDark() ? "dark" : "light");
			const [drafts, setDrafts] = (0, react.useState)({});
			const [added, setAdded] = (0, react.useState)([]);
			const [removed, setRemoved] = (0, react.useState)([]);
			const [editorId, setEditorId] = (0, react.useState)(null);
			const [saving, setSaving] = (0, react.useState)(false);
			const [saveMsg, setSaveMsg] = (0, react.useState)("");
			const [depLine, setDepLine] = (0, react.useState)(null);
			const [newChild, setNewChild] = (0, react.useState)("");
			const [recent, setRecent] = (0, react.useState)([]);
			const [projListOpen, setProjListOpen] = (0, react.useState)(false);
			const [apEdits, setApEdits] = (0, react.useState)({});
			const [apBusy, setApBusy] = (0, react.useState)("");
			const [apRev, setApRev] = (0, react.useState)(0);
			const [designOpen, setDesignOpen] = (0, react.useState)(false);
			const [design, setDesign] = (0, react.useState)(null);
			const [designMsg, setDesignMsg] = (0, react.useState)("");
			const [designBusy, setDesignBusy] = (0, react.useState)(false);
			const depOptions = (0, react.useMemo)(() => (data?.board.nodes ?? []).map((n) => ({
				id: n.id,
				title: n.title,
				type: n.type
			})), [data]);
			const [view, setView] = (0, react.useState)({
				k: 1,
				tx: 0,
				ty: 0
			});
			const dragRef = (0, react.useRef)(null);
			const svgRef = (0, react.useRef)(null);
			const editorRef = (0, react.useRef)(null);
			const streamTimerRef = (0, react.useRef)(null);
			const editorIdRef = (0, react.useRef)(null);
			editorIdRef.current = editorId;
			(0, react.useEffect)(() => {
				const t = setInterval(() => {
					const d = appDark();
					setMode((prev) => prev === (d ? "dark" : "light") ? prev : d ? "dark" : "light");
				}, 2e3);
				return () => clearInterval(t);
			}, []);
			(0, react.useEffect)(() => {
				setDesignOpen(false);
				setDesign(null);
				setDesignMsg("");
			}, [editorId]);
			(0, react.useEffect)(() => {
				if (!isAbsoluteProject(project)) return;
				const ctrl = new AbortController();
				let stop = false;
				const run = async () => {
					try {
						const reader = (await fetch(API + "/stream?project=" + encodeURIComponent(project), { signal: ctrl.signal })).body?.getReader();
						if (reader == null) return;
						const dec = new TextDecoder();
						let buf = "";
						while (!stop) {
							const chunk = await reader.read();
							if (chunk.done) break;
							buf += dec.decode(chunk.value, { stream: true });
							const lines = buf.split("\n");
							buf = lines.pop() ?? "";
							for (const line of lines) {
								if (line.trim() === "") continue;
								try {
									if (JSON.parse(line).kind === "event") setNonce((n) => n + 1);
								} catch {}
							}
						}
					} catch {}
					if (!stop) streamTimerRef.current = setTimeout(() => {
						streamTimerRef.current = null;
						run();
					}, 3e3);
				};
				run();
				return () => {
					stop = true;
					ctrl.abort();
					if (streamTimerRef.current != null) {
						clearTimeout(streamTimerRef.current);
						streamTimerRef.current = null;
					}
				};
			}, [project]);
			(0, react.useEffect)(() => {
				if (!isAbsoluteProject(project)) return;
				localStorage.setItem(PROJECT_KEY, project);
				let stop = false;
				let inFlight = false;
				const tick = async () => {
					if (inFlight) return;
					inFlight = true;
					try {
						const j = await (await fetch(API + "/state?project=" + encodeURIComponent(project))).json();
						if (stop) return;
						if (j.ok === true) {
							setData(j);
							setErr("");
						} else setErr(String(j.error?.message ?? "加载失败"));
					} catch (e) {
						if (!stop) setErr(String(e));
					} finally {
						inFlight = false;
					}
				};
				tick();
				const t = setInterval(tick, POLL_MS);
				return () => {
					stop = true;
					clearInterval(t);
				};
			}, [project, nonce]);
			ensureStyles();
			(0, react.useEffect)(() => {
				let stop = false;
				(async () => {
					try {
						const j = await (await fetch(API + "/projects")).json();
						if (stop || j.ok !== true || j.projects == null) return;
						const list = Object.entries(j.projects).map(([p, v]) => ({
							project: p,
							name: String(v.name ?? p),
							at: String(v.at ?? "")
						})).sort((x, y) => x.at < y.at ? 1 : -1);
						setRecent(list);
					} catch {}
				})();
				return () => {
					stop = true;
				};
			}, [nonce]);
			const b = data?.board;
			const effNodes = (0, react.useMemo)(() => {
				if (data == null) return [];
				const alive = data.board.nodes.filter((n) => !removed.includes(n.id)).map((n) => {
					const d = drafts[n.id];
					if (d == null) return n;
					return {
						...n,
						...d.fields ?? {},
						pos: d.pos !== void 0 ? d.pos : n.pos ?? null
					};
				});
				for (const a of added) alive.push({
					id: a.id,
					type: a.type,
					parent: a.parent,
					title: a.title,
					status: "planned",
					deps: []
				});
				return alive;
			}, [
				data,
				drafts,
				added,
				removed
			]);
			const layout = (0, react.useMemo)(() => {
				let y = 20;
				const items = [];
				const floating = [];
				const mods = effNodes.filter((n) => n.type === "module");
				for (const m of mods) {
					const tasks = effNodes.filter((t) => t.type === "task" && t.parent === m.id);
					const h = MOD_H + tasks.length * ROW + 8;
					const mx = m.pos != null ? m.pos.x : 180;
					const my = m.pos != null ? m.pos.y : y;
					const mi = {
						node: m,
						x: mx,
						y: my,
						w: 170,
						h: 36
					};
					if (m.pos != null) floating.push(mi);
					else items.push(mi);
					let ty = my + MOD_H;
					for (const t of tasks) {
						const ti = {
							node: t,
							x: t.pos != null ? t.pos.x : 410,
							y: t.pos != null ? t.pos.y : ty,
							w: 260,
							h: 24
						};
						if (t.pos != null) floating.push(ti);
						else items.push(ti);
						ty += ROW;
					}
					y = (m.pos != null ? my + h : y + h) + 18;
				}
				const totalH = Math.max(y + 20, 260);
				items.push(...floating);
				items.push({
					node: {
						id: "__root__",
						type: "module",
						parent: null,
						title: b?.plan.name ?? "Plan",
						status: "planned",
						deps: []
					},
					x: 16,
					y: totalH / 2 - 20,
					w: 130,
					h: 40
				});
				return {
					items,
					totalH
				};
			}, [effNodes, b]);
			const dirtyIds = (0, react.useMemo)(() => /* @__PURE__ */ new Set([
				...Object.keys(drafts),
				...added.map((a) => a.id),
				...removed
			]), [
				drafts,
				added,
				removed
			]);
			(0, react.useEffect)(() => {
				if (editorId == null) return;
				const el = editorRef.current;
				if (el == null) return;
				if (el.getBoundingClientRect().top > window.innerHeight - 40) el.scrollIntoView({ block: "nearest" });
			}, [editorId]);
			const dirtyCount = dirtyIds.size;
			const toSvg = (clientX, clientY) => {
				const rect = svgRef.current?.getBoundingClientRect();
				return {
					x: (clientX - (rect?.left ?? 0) - view.tx) / view.k,
					y: (clientY - (rect?.top ?? 0) - view.ty) / view.k
				};
			};
			const setDraft = (id, patch) => {
				setDrafts((prev) => ({
					...prev,
					[id]: {
						...prev[id],
						...patch,
						fields: {
							...prev[id]?.fields ?? {},
							...patch.fields ?? {}
						}
					}
				}));
			};
			const onNodePointerDown = (e, id, base) => {
				if (id === "__root__") return;
				const p = toSvg(e.clientX, e.clientY);
				dragRef.current = {
					kind: "node",
					id,
					sx: p.x,
					sy: p.y,
					bx: base.x,
					by: base.y,
					moved: false
				};
				try {
					e.target.setPointerCapture?.(e.pointerId);
				} catch {}
			};
			const onNodeMove = (id, pos) => {
				setDraft(id, { pos: {
					x: Math.round(pos.x),
					y: Math.round(pos.y)
				} });
			};
			const onNodeClick = (id) => {
				setEditorId((prev) => prev === id ? null : id);
				setSaveMsg("");
			};
			const onHandlePointerDown = (e, id) => {
				dragRef.current = {
					kind: "dep",
					from: id
				};
			};
			const onDepDrop = (from, at) => {
				const el = document.elementFromPoint(at.clientX, at.clientY);
				const gEl = el != null ? el.closest(".pb-node") : null;
				const hitId = gEl != null ? gEl.getAttribute("data-id") : null;
				if (hitId == null || hitId === from || hitId === "__root__") return;
				const tid = hitId;
				const cur = effNodes.find((n) => n.id === tid);
				if (cur == null || cur.type !== "task") return;
				const deps = [...cur.deps ?? []];
				const idx = deps.indexOf(from);
				if (idx >= 0) deps.splice(idx, 1);
				else deps.push(from);
				if (hasCycle(effNodes.filter((n) => !removed.includes(n.id)).map((n) => n.id === tid ? {
					...n,
					deps
				} : {
					...n,
					deps: [...n.deps ?? []]
				}).filter((n) => n.type === "task"))) {
					setSaveMsg("⛔ 该依赖会成环，已拒绝（" + tid + " ⇠ " + from + "）");
					return;
				}
				setDraft(tid, { fields: { deps } });
				setSaveMsg("");
			};
			const addChild = (parentId) => {
				const title = newChild.trim();
				if (title === "") return;
				const id = "pb-" + Date.now().toString(36);
				setAdded((prev) => [...prev, {
					id,
					type: "task",
					parent: parentId,
					title
				}]);
				setNewChild("");
				setEditorId(id);
			};
			const removeNode = (id) => {
				const node = effNodes.find((n) => n.id === id);
				if (node == null) return;
				if (effNodes.some((n) => n.parent === id)) {
					setSaveMsg("⛔ 先删除其子任务/子模块");
					return;
				}
				if (!window.confirm("删除节点 " + id + "（" + node.title + "）？")) return;
				if (!window.confirm("确认：该操作随「保存更改」一并生效，且会自动剥离其他任务对它的依赖。")) return;
				for (const n of effNodes) {
					if (n.id === id) continue;
					const ds = n.deps ?? [];
					if (ds.includes(id)) setDraft(n.id, { fields: { deps: ds.filter((d) => d !== id) } });
				}
				setRemoved((prev) => prev.includes(id) ? prev : [...prev, id]);
				if (editorId === id) setEditorId(null);
			};
			const save = async () => {
				if (saving || dirtyCount === 0) return;
				const ops = [];
				for (const a of added) ops.push({
					op: "add_node",
					node: {
						id: a.id,
						type: a.type,
						parent: a.parent,
						title: a.title
					}
				});
				for (const [id, d] of Object.entries(drafts)) {
					if (removed.includes(id)) continue;
					const fields = { ...d.fields ?? {} };
					if (d.pos != null) fields.pos = d.pos;
					if (Object.keys(fields).length === 0) continue;
					ops.push({
						op: "update_node",
						id,
						fields
					});
				}
				for (const id of removed) ops.push({
					op: "remove_node",
					id
				});
				if (ops.length === 0) {
					setDrafts({});
					setAdded([]);
					setRemoved([]);
					return;
				}
				if (hasCycle(effNodes.filter((n) => !removed.includes(n.id)).map((n) => {
					const d = drafts[n.id];
					return {
						id: n.id,
						deps: d?.fields?.deps ?? n.deps ?? []
					};
				}).filter((n) => n.id !== "__root__"))) {
					setSaveMsg("⛔ 保存被拒绝：依赖成环");
					return;
				}
				setSaving(true);
				setSaveMsg("");
				try {
					const j = await post("/edit", {
						project,
						ops,
						note: "panel:direct-edit"
					});
					if (j.ok === true) {
						setDrafts({});
						setAdded([]);
						setRemoved([]);
						setEditorId(null);
						setNonce((n) => n + 1);
					} else setSaveMsg("⛔ " + String(j.error?.message ?? "保存失败"));
				} catch (e) {
					setSaveMsg("⛔ " + String(e));
				}
				setSaving(false);
			};
			const discard = () => {
				setDrafts({});
				setAdded([]);
				setRemoved([]);
				setEditorId(null);
				setSaveMsg("");
			};
			const loadDesign = async (taskId) => {
				if (!isAbsoluteProject(project)) {
					setDesignMsg("⚠ 先在上面填项目根目录绝对路径");
					return;
				}
				setDesignBusy(true);
				setDesignMsg("");
				try {
					const j = await readJson(await fetch(API + "/design?project=" + encodeURIComponent(project) + "&taskId=" + encodeURIComponent(taskId)));
					if (editorIdRef.current !== taskId) return;
					if (j.ok !== true) {
						setDesignMsg("⛔ 读子导图失败：" + errText(j.error));
						setDesign(null);
						return;
					}
					setDesign(j.design == null ? null : normDesign(j.design));
				} catch (e) {
					if (editorIdRef.current !== taskId) return;
					setDesignMsg("⛔ 读子导图失败：" + String(e));
					setDesign(null);
				}
				if (editorIdRef.current === taskId) setDesignBusy(false);
			};
			const saveDesign = async (taskId) => {
				if (design == null) return;
				if (editorIdRef.current !== taskId) {
					setDesignMsg("⛔ 当前任务已经切换，放弃保存（避免写错文件）");
					return;
				}
				setDesignBusy(true);
				setDesignMsg("");
				try {
					const j = await post("/design", {
						project,
						taskId,
						design: designToWire(design)
					});
					if (j.ok !== true) {
						setDesignMsg("⛔ 保存子导图失败：" + errText(j.error));
						return;
					}
					setDesign(j.design == null ? design : normDesign(j.design));
					setDesignMsg("✅ 子导图已保存");
				} catch (e) {
					setDesignMsg("⛔ 保存子导图失败：" + String(e));
				}
				setDesignBusy(false);
			};
			const patchDesign = (p) => {
				setDesign((prev) => prev == null ? prev : {
					...prev,
					...p
				});
			};
			const approveAp = async (ap) => {
				const orig = normOps(ap.ops);
				const edited = apEdits[ap.id] ?? orig;
				const body = {
					project,
					approvalId: ap.id,
					decision: "approve"
				};
				if (opsChanged(orig, edited)) body.ops = edited.map(toWire);
				setApBusy(ap.id);
				setSaveMsg("");
				try {
					const j = await post("/approve", body);
					if (j.ok === true) {
						setApEdits((prev) => {
							const n = { ...prev };
							delete n[ap.id];
							return n;
						});
						setNonce((n) => n + 1);
					} else setSaveMsg("⛔ 批准失败：" + errText(j.error));
				} catch (e) {
					setSaveMsg("⛔ 批准失败：" + String(e));
				}
				setApBusy("");
			};
			const rejectAp = async (ap) => {
				setApBusy(ap.id);
				try {
					const j = await post("/approve", {
						project,
						approvalId: ap.id,
						decision: "reject"
					});
					if (j.ok === true) {
						setApEdits((prev) => {
							const n = { ...prev };
							delete n[ap.id];
							return n;
						});
						setNonce((n) => n + 1);
					} else setSaveMsg("⛔ 驳回失败：" + errText(j.error));
				} catch (e) {
					setSaveMsg("⛔ 驳回失败：" + String(e));
				}
				setApBusy("");
			};
			const editor = editorId != null ? effNodes.find((n) => n.id === editorId) : void 0;
			const tasksOf = (pred) => effNodes.filter((n) => n.type === "task" && !removed.includes(n.id) && pred(n));
			const fd = (editor != null ? drafts[editor.id]?.fields : void 0) ?? {};
			const dirtyField = (editorId2, k) => editorId2 != null && drafts[editorId2]?.fields != null && drafts[editorId2].fields[k] !== void 0;
			const editorChildren = [];
			if (editor != null) {
				editorChildren.push((0, react.createElement)("div", { style: {
					display: "flex",
					alignItems: "center",
					gap: "8px"
				} }, (0, react.createElement)("span", { className: "pb-sec" }, "编辑 " + editor.id + "（" + (editor.type === "task" ? "任务" : "模块") + "）"), (0, react.createElement)("button", {
					className: "pb-btn",
					style: { marginLeft: "auto" },
					onClick: () => setEditorId(null)
				}, "完成")));
				editorChildren.push((0, react.createElement)("label", {}, "标题" + (dirtyField(editor.id, "title") ? " ●" : ""), (0, react.createElement)("input", {
					value: fd.title ?? editor.title,
					onChange: (e) => setDraft(editor.id, { fields: { title: e.target.value } })
				})));
				if (editor.type === "task") editorChildren.push((0, react.createElement)("label", {}, "优先级" + (dirtyField(editor.id, "priority") ? " ●" : ""), (0, react.createElement)("select", {
					value: String(fd.priority ?? editor.priority ?? 3),
					onChange: (e) => setDraft(editor.id, { fields: { priority: Number(e.target.value) } })
				}, [
					1,
					2,
					3,
					4,
					5
				].map((pv) => (0, react.createElement)("option", {
					key: pv,
					value: String(pv)
				}, "P" + pv)))));
				editorChildren.push((0, react.createElement)("label", {}, "备注" + (dirtyField(editor.id, "note") ? " ●" : ""), (0, react.createElement)("textarea", {
					value: fd.note ?? editor.note ?? "",
					onChange: (e) => setDraft(editor.id, { fields: { note: e.target.value } })
				})));
				if (editor.type === "task") {
					editorChildren.push((0, react.createElement)("label", {}, "验收标准（每行一条）" + (dirtyField(editor.id, "acceptance") ? " ●" : ""), (0, react.createElement)("textarea", {
						value: (fd.acceptance ?? editor.acceptance ?? []).join("\n"),
						onChange: (e) => setDraft(editor.id, { fields: { acceptance: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) } })
					})));
					editorChildren.push((0, react.createElement)("label", {}, "scope（每行一条路径前缀，目录以 / 结尾）" + (dirtyField(editor.id, "scope") ? " ●" : ""), (0, react.createElement)("textarea", {
						value: (fd.scope ?? editor.scope ?? []).join("\n"),
						onChange: (e) => setDraft(editor.id, { fields: { scope: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) } })
					})));
					const depDeps = fd.deps ?? editor.deps ?? [];
					editorChildren.push((0, react.createElement)("div", {}, (0, react.createElement)("span", { className: "pb-sec" }, "依赖（被此任务依赖的前置任务）" + (dirtyField(editor.id, "deps") ? " ●" : "")), tasksOf((n) => n.id !== editor.id).map((dn) => (0, react.createElement)("label", {
						className: "pb-deprow",
						key: dn.id
					}, (0, react.createElement)("input", {
						type: "checkbox",
						checked: depDeps.includes(dn.id),
						onChange: (e) => {
							const arr = (fd.deps ?? editor.deps ?? []).slice();
							const i2 = arr.indexOf(dn.id);
							if (e.target.checked && i2 < 0) arr.push(dn.id);
							if (!e.target.checked && i2 >= 0) arr.splice(i2, 1);
							setDraft(editor.id, { fields: { deps: arr } });
						}
					}), (0, react.createElement)("span", {}, "#" + (data?.order[dn.id] ?? "?") + " " + dn.id + " " + dn.title.slice(0, 22))))));
				}
				if (editor.type === "task") {
					editorChildren.push((0, react.createElement)("div", { className: "pb-designbar" }, (0, react.createElement)("button", {
						className: "pb-btn pb-vio",
						onClick: () => {
							const next = !designOpen;
							setDesignOpen(next);
							if (next) loadDesign(editor.id);
						}
					}, designOpen ? "收起子导图" : "子导图" + (hasDesignPointer(fd.note ?? editor.note) ? " ●" : "")), (0, react.createElement)("span", { className: "pb-hint" }, "功能实现子导图（步骤 / 涉及文件 / 风险 / 测试），存在 .plan-board/designs/" + editor.id + ".json")));
					if (designOpen) {
						const d = design;
						editorChildren.push((0, react.createElement)("div", { className: "pb-design" }, designBusy && d == null ? (0, react.createElement)("div", { className: "pb-hint" }, "读取子导图…") : null, !designBusy && d == null ? (0, react.createElement)("div", { className: "pb-hint" }, "该任务没有子导图", (0, react.createElement)("button", {
							className: "pb-btn",
							style: { marginLeft: "8px" },
							onClick: () => {
								setDesign(emptyDesign());
								setDesignMsg("");
							}
						}, "新建空子导图")) : null, d != null ? (0, react.createElement)("div", { className: "pb-form" }, (0, react.createElement)("label", {}, "概述", (0, react.createElement)("textarea", {
							value: d.summary,
							onChange: (e) => patchDesign({ summary: e.target.value })
						})), (0, react.createElement)("div", { className: "pb-oplabel" }, "步骤（有序）", (0, react.createElement)("ol", { className: "pb-designsteps" }, d.steps.map((s, i) => (0, react.createElement)("li", { key: "ds" + i }, (0, react.createElement)("input", {
							value: s,
							onChange: (e) => patchDesign({ steps: d.steps.map((x, k) => k === i ? e.target.value : x) })
						}), (0, react.createElement)("button", {
							className: "pb-btn",
							onClick: () => patchDesign({ steps: d.steps.filter((_, k) => k !== i) })
						}, "删")))), (0, react.createElement)("button", {
							className: "pb-btn",
							onClick: () => patchDesign({ steps: [...d.steps, ""] })
						}, "＋步骤")), (0, react.createElement)("label", {}, "涉及文件（每行一条）", (0, react.createElement)("textarea", {
							value: d.files.join("\n"),
							onChange: (e) => patchDesign({ files: splitLines(e.target.value) })
						})), (0, react.createElement)("label", {}, "风险（每行一条）", (0, react.createElement)("textarea", {
							value: d.risks.join("\n"),
							onChange: (e) => patchDesign({ risks: splitLines(e.target.value) })
						})), (0, react.createElement)("label", {}, "怎么验（每行一条）", (0, react.createElement)("textarea", {
							value: d.tests.join("\n"),
							onChange: (e) => patchDesign({ tests: splitLines(e.target.value) })
						})), Object.keys(d.extra).length > 0 ? (0, react.createElement)("div", { className: "pb-oplabel" }, "其它字段（只读，保存时原样带回）", (0, react.createElement)("div", { className: "pb-designextra" }, JSON.stringify(d.extra, null, 2))) : null, (0, react.createElement)("div", { style: {
							display: "flex",
							gap: "8px",
							alignItems: "center"
						} }, (0, react.createElement)("button", {
							className: "pb-btn pb-ok",
							disabled: designBusy,
							onClick: () => {
								saveDesign(editor.id);
							}
						}, designBusy ? "保存中…" : "保存子导图"), designMsg !== "" ? (0, react.createElement)("span", { className: "pb-hint" }, designMsg) : null)) : null, d == null && designMsg !== "" ? (0, react.createElement)("div", { className: "pb-hint" }, designMsg) : null));
					}
				}
				if (editor.type === "module") editorChildren.push((0, react.createElement)("div", { style: {
					display: "flex",
					gap: "6px"
				} }, (0, react.createElement)("input", {
					className: "pb-input",
					style: { flex: 1 },
					value: newChild,
					placeholder: "新子任务标题（回车或点按钮加入，保存后生效）",
					onChange: (e) => setNewChild(e.target.value),
					onKeyDown: (e) => {
						if (e.key === "Enter") addChild(editor.id);
					}
				}), (0, react.createElement)("button", {
					className: "pb-btn pb-vio",
					disabled: newChild.trim() === "",
					onClick: () => addChild(editor.id)
				}, "＋子任务")));
				editorChildren.push((0, react.createElement)("div", { style: {
					display: "flex",
					gap: "8px"
				} }, (0, react.createElement)("button", {
					className: "pb-btn pb-no",
					onClick: () => removeNode(editor.id)
				}, "删除节点"), (0, react.createElement)("span", {
					className: "pb-hint",
					style: { alignSelf: "center" }
				}, editor.type === "task" ? "状态流转与证据走 task_update（L3 证据门），不在面板直改" : "模块删除需先清空子任务")));
			}
			const editorCard = editor != null ? (0, react.createElement)("div", {
				className: "pb-card pb-form",
				key: "editor",
				ref: editorRef
			}, editorChildren) : null;
			return (0, react.createElement)("div", {
				className: "pb-panel",
				"data-mode": mode,
				"data-collapsed": collapsed ? "true" : void 0
			}, (0, react.createElement)("div", { className: "pb-head" }, (0, react.createElement)("span", { className: "pb-title" }, "🗺 PlanBoard"), (0, react.createElement)("input", {
				className: "pb-input",
				value: project,
				placeholder: "项目根目录绝对路径，如 /path/to/your/project 或 C:\\path\\to\\project",
				onChange: (e) => setProject(e.target.value),
				onBlur: () => {
					rememberProject(project);
				}
			}), (0, react.createElement)("button", {
				className: "pb-btn",
				onClick: () => setCollapsed((v) => !v)
			}, collapsed ? "展开" : "收起")), (0, react.createElement)("div", { className: "pb-projrow" }, (0, react.createElement)("span", {}, "当前项目："), (0, react.createElement)("span", {
				className: "pb-projpath",
				title: project,
				onClick: () => setProjListOpen((v) => !v)
			}, project.trim() === "" ? "（未设置）" : project), (0, react.createElement)("span", {
				className: "pb-hint",
				style: { cursor: "pointer" },
				onClick: () => setProjListOpen((v) => !v)
			}, "（点此切换）"), recent.slice(0, 12).map((r) => (0, react.createElement)("button", {
				key: r.project,
				className: "pb-tag" + (r.project === project ? " pb-on" : ""),
				title: r.project,
				onClick: () => {
					setProject(r.project);
					setProjListOpen(false);
					setSaveMsg("");
					rememberProject(r.project);
				}
			}, projListOpen ? clip(r.name, 18) + " · " + r.project : clip(r.name, 18)))), err !== "" ? (0, react.createElement)("div", { className: "pb-banner pb-drift" }, "⚠ " + err) : null, b == null ? (0, react.createElement)("div", { className: "pb-body" }, (0, react.createElement)("div", { className: "pb-card" }, (0, react.createElement)("div", { style: {
				fontWeight: 700,
				marginBottom: "4px"
			} }, project.trim() === "" ? "① 选一个最近打开的项目（或把项目根目录粘到上面的输入框）" : "⚠ 这个项目下还没有 .plan-board/"), (0, react.createElement)("div", { className: "pb-hint" }, project.trim() === "" ? "面板只读+直改规划；任务状态仍走 task_update（L3 证据门）。① 点上面一行里的项目标签切换；② 或直接在顶部输入框写一句话生成导图（服务端自动起板，结构变更先进待批队列，人可改可驳）。" : "这个项目下还没有 .plan-board/。不碍事：在顶部输入框写一句话就能生成导图（服务端自动起板 + 进待批队列，人可改内容再确认）；也可以让 Agent 跑 plan_edit init_board 起板。"), recent.length > 0 ? (0, react.createElement)("div", { style: {
				display: "flex",
				flexWrap: "wrap",
				gap: "6px",
				marginTop: "10px"
			} }, recent.map((r) => (0, react.createElement)("button", {
				key: r.project,
				className: "pb-btn",
				title: r.project,
				onClick: () => setProject(r.project)
			}, r.name + " · " + r.project))) : null)) : (0, react.createElement)("div", { className: "pb-body" }, dirtyCount > 0 ? (0, react.createElement)("div", { className: "pb-banner pb-dirty" }, "● " + dirtyCount + " 项未保存更改（拖拽位置/内容/依赖/增删，保存后才生效）", (0, react.createElement)("button", {
				className: "pb-btn pb-ok",
				style: { marginLeft: "auto" },
				disabled: saving,
				onClick: () => {
					save();
				}
			}, saving ? "保存中…" : "保存更改"), (0, react.createElement)("button", {
				className: "pb-btn",
				disabled: saving,
				onClick: discard
			}, "放弃")) : null, saveMsg !== "" ? (0, react.createElement)("div", { className: "pb-banner pb-drift" }, saveMsg) : null, b.driftBlock != null ? (0, react.createElement)("div", { className: "pb-banner pb-drift" }, "⛔ 漂移阻断: " + b.driftBlock.reason, (0, react.createElement)("button", {
				className: "pb-btn pb-ok",
				style: { marginLeft: "auto" },
				onClick: () => {
					post("/unblock", { project }).then(() => setNonce((n) => n + 1));
				}
			}, "解除阻断")) : null, data?.guard?.suspended ? (0, react.createElement)("div", { className: "pb-banner pb-hold" }, "⏸ L7 越界拦截已挂起（仅内存态，重启后自动恢复拦截）", (0, react.createElement)("button", {
				className: "pb-btn pb-ok",
				style: { marginLeft: "auto" },
				onClick: () => {
					post("/guard", {
						project,
						suspended: false
					}).then(() => setNonce((n) => n + 1));
				}
			}, "恢复拦截")) : null, (() => {
				const blocks = (data?.events ?? []).filter((ev) => ev.kind === "guard_block");
				if (blocks.length === 0 || data?.guard?.suspended) return null;
				const last = blocks[blocks.length - 1];
				return (0, react.createElement)("div", { className: "pb-banner pb-guard" }, "🛡 L7 越界拦截 " + blocks.length + " 次: " + (last.payload?.tool ?? "?") + " → " + (last.payload?.path ?? "?") + "（任务 " + (last.payload?.taskId ?? "?") + "）", (0, react.createElement)("button", {
					className: "pb-btn",
					style: { marginLeft: "auto" },
					onClick: () => {
						post("/guard", {
							project,
							suspended: true
						}).then(() => setNonce((n) => n + 1));
					}
				}, "暂停拦截"));
			})(), b.pendingApprovals.length > 0 ? (0, react.createElement)("div", { className: "pb-banner pb-appr" }, "⏳ " + b.pendingApprovals.length + " 个 plan_edit 待批", (0, react.createElement)("span", { style: {
				fontWeight: 400,
				opacity: .85
			} }, b.pendingApprovals[0].reason.slice(0, 60))) : null, b.pendingApprovals.map((ap) => {
				const orig = normOps(ap.ops);
				const ops = apEdits[ap.id] ?? orig;
				const extra = [];
				for (const o of ops) if (o.op === "add_node") extra.push({
					id: o.node.id,
					title: o.node.title,
					type: o.node.type
				});
				return (0, react.createElement)(ApprovalCard, {
					key: ap.id,
					ap,
					ops,
					origOps: orig,
					dirty: opsChanged(orig, ops),
					cycle: proposalCycle(b.nodes, ops),
					issues: proposalParentIssues(b.nodes, ops),
					options: mergeDepOptions(depOptions, extra),
					busy: apBusy === ap.id,
					rev: apRev,
					onOps: (next) => {
						setApEdits((prev) => ({
							...prev,
							[ap.id]: next
						}));
					},
					onReset: () => {
						setApEdits((prev) => {
							const n = { ...prev };
							delete n[ap.id];
							return n;
						});
						setApRev((r) => r + 1);
					},
					onApprove: () => {
						approveAp(ap);
					},
					onReject: () => {
						rejectAp(ap);
					}
				});
			}), (0, react.createElement)("div", { className: "pb-sec" }, "任务思维导图 v" + b.version + " · digest " + (b.digest ?? "").slice(0, 10) + " · 拖拽移动 / 点节点编辑 / 紫点拖出连依赖"), (0, react.createElement)(MindMap, {
				data,
				effNodes,
				layout,
				dirtyIds,
				view,
				setView,
				dragRef,
				depLine,
				setDepLine,
				editorId,
				onNodePointerDown,
				onNodeMove,
				onNodeClick,
				onDepDrop,
				onHandlePointerDown,
				svgRef
			}), editorCard, (0, react.createElement)("div", { className: "pb-sec" }, "事件时间线"), (0, react.createElement)("div", { className: "pb-card" }, (data?.events ?? []).slice(-24).reverse().map((ev) => (0, react.createElement)("div", {
				className: "pb-ev",
				key: ev.seq
			}, (0, react.createElement)("span", {}, new Date(ev.ts).toLocaleTimeString()), (0, react.createElement)("span", { style: { fontWeight: 700 } }, ev.kind), (0, react.createElement)("span", { style: { opacity: .7 } }, ev.actor))))));
		}
		/** 客户端模块要的服务：slots（插槽）+ locale（侧栏图标的字典）。 */
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, LOCALE_DICT), NS + ": dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.effect(() => {
				ctx.slots.inject("main", () => ctx.slots.register({
					name: "main",
					key: PANEL_ID,
					locale: NS,
					inject: () => ({})
				}, PanelHost));
				ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					order: 11,
					label: () => t("panel"),
					locale: NS
				}, PanelBoardIcon));
				ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
					name: "conversation.input.left",
					id: NS + ":mode",
					order: .5,
					inject: (sessionId) => ({ sessionId })
				}, PlanBoardModeChip));
			}, NS + ":ui");
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map