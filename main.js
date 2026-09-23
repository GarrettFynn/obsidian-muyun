'use strict';

/* MuYun Companion · v0.2.0
   MuYun 慕云主题的配套增强插件，承载主题（纯 CSS）无法实现的效果：
   H1 顶部阅读进度条 / H2 阅读聚光灯（默认关）/ H8 侧缘小地图点轨
   + v0.2 新增：续读记忆 / 状态栏标题面包屑 / 小地图阅读轨迹与悬停预览 /
     编辑态段落聚焦（CM6，默认关）/ 打字机滚动（CM6，默认关）/
     状态栏阅读时长 / 小地图↔大纲联动 / 读完柔光（一次性彩蛋）。
   纯 JavaScript（无构建链），CommonJS 引用运行时 obsidian 模块。
   设计文档：《MuYun 设计文档 v0.3》§7；样式走主题 CSS 变量，主题缺席时优雅降级。 */

const { Plugin, PluginSettingTab, Setting, MarkdownView, Notice, debounce } = require('obsidian');

/* CM6 能力探测：段落聚焦与打字机滚动依赖 EditorView 体系；旧版缺失时自动禁用这两项 */
const obs = require('obsidian');
const CM = {
	ViewPlugin: obs.ViewPlugin,
	Decoration: obs.Decoration,
	RangeSetBuilder: obs.RangeSetBuilder
};
const CM_OK = !!(CM.ViewPlugin && CM.Decoration && CM.RangeSetBuilder);

const DEFAULT_SETTINGS = {
	progressBar: true,      /* H1 顶部阅读进度条 */
	minimap: true,          /* H8 侧缘小地图点轨 */
	minimapTrail: true,     /* 小地图已读轨迹着色 */
	spotlight: false,       /* H2 阅读聚光灯（观感争议项，默认关） */
	spotlightDim: 0.35,     /* 聚光灯暗度 */
	resumeReading: true,    /* 续读记忆 */
	breadcrumb: true,       /* 状态栏标题面包屑 */
	readTime: true,         /* 状态栏阅读时长估计 */
	editorFocus: false,     /* 编辑态段落聚焦（写作聚光灯，默认关） */
	typewriter: false,      /* 打字机滚动（默认关） */
	finishGlow: true        /* 读完柔光（一次性彩蛋） */
};

const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';
const HEADING_SCOPE_SEL = HEADING_SEL.split(', ').map(function (s) { return ':scope > ' + s; }).join(', ');
const STORE_KEY = 'muyun-companion.readpos.v1';
const STORE_MAX = 400;

function isHeadingBlock(el) {
	return el.matches(HEADING_SEL) || !!el.querySelector(HEADING_SCOPE_SEL);
}

class MuyunCompanionPlugin extends Plugin {

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		/* 运行时状态 */
		this.barEl = null;
		this.barFill = null;
		this.railEl = null;
		this.railView = null;
		this.railTargets = null;
		this.railHeads = [];
		this.railMaxRead = -1;
		this.dimContainer = null;
		this.dimBlocks = [];
		this.lastSpotKey = '';
		this._spotCache = null;
		this.raf = 0;
		this.crumbEl = this.addStatusBarItem();
		this.timeEl = this.addStatusBarItem();
		this.crumbEl.addClass('muyun-crumb');
		this.timeEl.addClass('muyun-readtime');
		this.loadStore();

		this.addSettingTab(new MuyunCompanionSettingTab(this.app, this));

		/* 命令（可绑快捷键） */
		const toggles = [
			['切换阅读进度条', 'progressBar'],
			['切换阅读聚光灯', 'spotlight'],
			['切换侧缘小地图', 'minimap'],
			['切换标题面包屑', 'breadcrumb'],
			['切换续读记忆', 'resumeReading'],
			['切换编辑态段落聚焦', 'editorFocus'],
			['切换打字机滚动', 'typewriter']
		];
		toggles.forEach(pair => this.addCommand({
			name: pair[0],
			callback: () => this.toggle(pair[1])
		}));

		/* H1 进度条挂在 body 上，全生命周期存在，按需显隐 */
		this.initBar();
		this.register(() => this.clearRail());

		/* 编辑态段落聚焦 / 打字机滚动（CM6 编辑器扩展；能力缺失或未开启时为空操作） */
		if (CM_OK) this.registerEditorExtension(this.buildCmExtension());

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refresh()));
		this.registerEvent(this.app.workspace.on('layout-change', debounce(() => this.refresh(), 150, true)));
		this.registerEvent(this.app.workspace.on('file-open', file => {
			this.restoreFor(file);
			this.computeReadTime();
			this.refresh();
		}));
		this.registerEvent(this.app.workspace.on('editor-change', debounce(() => {
			this.refreshSoft();
			this.computeReadTime();
		}, 800, true)));
		this.registerDomEvent(window, 'resize', () => { this._spotCache = null; this.updateProgress(); });
		this.registerDomEvent(document, 'scroll', () => this.onScroll(), { capture: true, passive: true });

		this.refresh();
		this.computeReadTime();
	}

	onunload() {
		this.teardownBar();
		this.clearRail();
		this.clearDim();
		this.crumbEl.empty();
		this.timeEl.empty();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refresh();
		this.updateBreadcrumb();
	}

	toggle(key) {
		this.settings[key] = !this.settings[key];
		this.saveSettings();
		new Notice('MuYun Companion：' + this.label(key) + '已' + (this.settings[key] ? '开启' : '关闭'));
	}

	label(key) {
		return {
			progressBar: '阅读进度条', spotlight: '阅读聚光灯', minimap: '侧缘小地图',
			breadcrumb: '标题面包屑', resumeReading: '续读记忆',
			editorFocus: '编辑态段落聚焦', typewriter: '打字机滚动'
		}[key] || key;
	}

	activeMarkdownView() {
		return this.app.workspace.getActiveViewOfType(MarkdownView);
	}

	/* 当前视图的滚动容器：阅读态 = .markdown-preview-view；编辑态 = .cm-scroller */
	scrollElOf(view) {
		if (!view) return null;
		const ce = view.contentEl;
		return view.getMode() === 'preview'
			? ce.querySelector('.markdown-preview-view')
			: ce.querySelector('.cm-scroller');
	}

	refresh() {
		this.updateProgress();
		this.buildRail();
		this.applySpotlight();
		this.updateBreadcrumb();
	}

	refreshSoft() {
		this.updateProgress();
		if (this.settings.minimap) this.buildRail();
		if (this.settings.spotlight) this.applySpotlight();
		this.updateBreadcrumb();
	}

	onScroll() {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.updateProgress();
			this.applySpotlight();
			this.updateRail();
			this.updateBreadcrumb();
			this.saveCurrentPosSoon();
		});
	}

	/* ═══ H1 顶部阅读进度条 ═══ */
	initBar() {
		this.barEl = document.createElement('div');
		this.barEl.className = 'muyun-progress';
		this.barFill = document.createElement('div');
		this.barFill.className = 'muyun-progress-fill';
		this.barEl.appendChild(this.barFill);
		document.body.appendChild(this.barEl);
		this.register(() => { if (this.barEl) this.barEl.remove(); });
	}

	teardownBar() {
		if (this.barEl) this.barEl.remove();
		this.barEl = null;
	}

	updateProgress() {
		const view = this.activeMarkdownView();
		const el = this.scrollElOf(view);
		let pct = 0;
		let show = false;
		if (this.settings.progressBar && el) {
			const max = el.scrollHeight - el.clientHeight;
			if (max > 4) {
				pct = Math.min(100, Math.max(0, (el.scrollTop / max) * 100));
				show = true;
			}
		}
		this.barEl.classList.toggle('on', show);
		this.barFill.style.width = pct + '%';

		/* 读完柔光（一次性彩蛋）：单篇首次触底时进度条柔光 0.9s */
		if (show && pct >= 99.5 && this.settings.finishGlow) {
			const file = this.app.workspace.getActiveFile();
			if (file) {
				const rec = this.store[file.path] || (this.store[file.path] = { ts: Date.now() });
				if (!rec.done) {
					rec.done = true;
					this.saveStoreSoon();
					this.barFill.classList.add('muyun-glow');
					const fill = this.barFill;
					setTimeout(function () { fill.classList.remove('muyun-glow'); }, 900);
				}
			}
		}
	}

	/* ═══ H2 阅读聚光灯（仅阅读视图；当前小节全亮，其余降透明） ═══ */
	clearDim() {
		this.dimBlocks.forEach(function (b) { b.classList.remove('muyun-dim'); });
		this.dimBlocks = [];
		this.dimContainer = null;
		this.lastSpotKey = '';
		this._spotCache = null;
	}

	applySpotlight() {
		const view = this.activeMarkdownView();
		const previewEl = view && view.getMode() === 'preview'
			? view.contentEl.querySelector('.markdown-preview-view')
			: null;
		if (!this.settings.spotlight || !previewEl) {
			if (this.dimContainer) this.clearDim();
			return;
		}
		if (this.dimContainer !== previewEl) this.clearDim();
		previewEl.style.setProperty('--muyun-dim', String(this.settings.spotlightDim));

		const blocks = this.resolveBlocks(previewEl);
		if (!blocks.length) return;

		/* 定位当前小节：以视口上 35% 为 reading line，取其上方最近的标题块 */
		/* 偏移缓存：布局高度未变时复用标题块内容偏移（滚动零布局读；高度变化/换容器/resize 才重算） */
		if (!this._spotCache || this._spotCache.el !== previewEl || this._spotCache.height !== previewEl.scrollHeight) {
			const baseTop = previewEl.getBoundingClientRect().top;
			const st = previewEl.scrollTop;
			this._spotCache = {
				el: previewEl,
				height: previewEl.scrollHeight,
				tops: blocks.map(function (b) { return b.getBoundingClientRect().top - baseTop + st; })
			};
		}
		const tops = this._spotCache.tops;
		const heads = [];
		blocks.forEach(function (b, i) { if (isHeadingBlock(b)) heads.push(i); });
		let active = 0;
		heads.forEach(function (idx, k) {
			if (tops[idx] - previewEl.scrollTop <= previewEl.clientHeight * 0.35) active = k;
		});
		const from = heads.length ? heads[active] : 0;
		const to = heads.length && active + 1 < heads.length ? heads[active + 1] : blocks.length;

		/* 签名守卫：小节未变化时不做任何 DOM 写操作（消除每帧重算） */
		const key = from + '-' + to + ':' + blocks.length;
		if (key === this.lastSpotKey) return;
		this.lastSpotKey = key;

		this.dimBlocks.forEach(function (b) { b.classList.remove('muyun-dim'); });
		this.dimBlocks = [];
		for (let i = 0; i < blocks.length; i++) {
			if (i < from || i >= to) {
				blocks[i].classList.add('muyun-dim');
				this.dimBlocks.push(blocks[i]);
			}
		}
		previewEl.style.setProperty('--muyun-dim', String(this.settings.spotlightDim));
		this.dimContainer = previewEl;
	}

	/* 分块定位：现代渲染链为 .markdown-preview-view > .markdown-preview-sizer > .el-* 块；
	   顶层找不到标题块时逐层下钻（最多 3 层），兼容新旧渲染结构 */
	resolveBlocks(previewEl) {
		let blocks = Array.from((previewEl.querySelector('.markdown-preview-sizer') || previewEl).children);
		let guard = 0;
		while (blocks.length && !blocks.some(isHeadingBlock) && guard < 3) {
			const next = blocks.map(function (b) { return Array.from(b.children); })
				.find(function (a) { return a.some(isHeadingBlock); });
			if (!next) break;
			blocks = next;
			guard++;
		}
		return blocks;
	}

	/* ═══ H8 侧缘小地图点轨（仅阅读视图；跟随滚动 + 点击跳转 + 已读轨迹 + 悬停预览） ═══ */
	clearRail() {
		if (this.railEl) this.railEl.remove();
		if (this.railView) this.railView.contentEl.classList.remove('muyun-has-rail');
		this.railEl = null;
		this.railView = null;
		this.railHeads = [];
		this.railTargets = null;
		this.railSig = '';
	}

	buildRail() {
		const view = this.activeMarkdownView();
		if (!this.settings.minimap || !view) { this.clearRail(); return; }
		if (this.railEl && this.railEl.parentElement !== view.contentEl) this.clearRail();

		/* 目标解析：阅读态 = 标题元素（跟随滚动）；实时预览 = metadataCache 标题行（跟随光标） */
		let targets;
		if (view.getMode() === 'preview') {
			const previewEl = view.contentEl.querySelector('.markdown-preview-view');
			if (!previewEl) { this.clearRail(); return; }
			targets = Array.from(previewEl.querySelectorAll(HEADING_SEL)).map(function (h) {
				return { el: h, line: null, level: +h.tagName[1], text: (h.textContent || '').trim() };
			});
		} else {
			const file = this.app.workspace.getActiveFile();
			const cache = file ? this.app.metadataCache.getFileCache(file) : null;
			const hs = cache && cache.headings ? cache.headings : [];
			targets = hs.map(function (h) {
				return { el: null, line: h.position.start.line, level: h.level, text: h.heading || '' };
			});
		}
		if (!targets.length) { this.clearRail(); return; }

		if (!this.railEl) {
			this.railEl = document.createElement('div');
			this.railEl.className = 'muyun-rail';
			view.contentEl.classList.add('muyun-has-rail');
			view.contentEl.appendChild(this.railEl);
			this.railView = view;
		}

		/* 内容签名（数量+层级+标题文本+模式）变化才重建点轨，避免旧元素闭包悬挂；续读记忆同步已读轨迹 */
		const sig = targets.length + '¦' + view.getMode() + '¦' + targets.map(function (t) { return t.level + ':' + t.text; }).join('¦');
		if (this.railSig !== sig) {
			this.railSig = sig;
			this.railEl.innerHTML = '';
			this.railTargets = targets;
			this.railHeads = targets.map(function (t) { return t.el; }).filter(Boolean);
			const file = this.app.workspace.getActiveFile();
			const rec = file ? this.store[file.path] : null;
			this.railMaxRead = rec && typeof rec.readIdx === 'number' ? rec.readIdx : -1;
			const self = this;
			targets.forEach(function (t) {
				const b = document.createElement('button');
				b.className = 'muyun-rail-dot lvl' + t.level;
				const txt = t.text;
				b.setAttribute('aria-label', txt.slice(0, 48));
				b.addEventListener('click', function () {
					if (t.el) {
						t.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
					} else {
						try {
							view.editor.setCursor({ line: t.line, ch: 0 });
							view.editor.scrollIntoView({ from: { line: t.line, ch: 0 }, to: { line: t.line, ch: 0 } }, true);
						} catch (e) { /* 编辑器不可用时静默 */ }
					}
					self.pulseOutline();
				});
				b.addEventListener('mouseenter', function () { self.showRailTip(b, 'H' + t.level + ' · ' + txt); });
				b.addEventListener('mouseleave', function () { self.showRailTip(null); });
				self.railEl.appendChild(b);
			});
		}
		this.updateRail();
	}

	updateRail() {
		if (!this.railEl || !this.railTargets || !this.railTargets.length || !this.railView) return;
		const view = this.railView;
		const dots = this.railEl.querySelectorAll('button');
		let cur = 0;
		if (view.getMode() === 'preview') {
			const previewEl = view.contentEl.querySelector('.markdown-preview-view');
			if (!previewEl) return;
			const baseTop = previewEl.getBoundingClientRect().top;
			this.railTargets.forEach(function (t, i) {
				if (t.el && t.el.getBoundingClientRect().top - baseTop <= previewEl.clientHeight * 0.35) cur = i;
			});
		} else {
			try {
				const cl = view.editor.getCursor().line;
				this.railTargets.forEach(function (t, i) { if (t.line <= cl) cur = i; });
			} catch (e) { /* 光标暂不可得时保持原状 */ }
		}
		if (this.settings.minimapTrail && view.getMode() === 'preview') {
			this.railMaxRead = Math.max(this.railMaxRead, cur);
		}
		const maxRead = this.railMaxRead;
		const trail = this.settings.minimapTrail && view.getMode() === 'preview';
		dots.forEach(function (b, i) {
			b.classList.toggle('cur', i === cur);
			b.classList.toggle('read', trail && i <= maxRead && i !== cur);
		});
		const file = this.app.workspace.getActiveFile();
		if (file && this.store[file.path]) {
			this.store[file.path].readIdx = maxRead;
			this.saveStoreSoon();
		}
	}

	/* 悬停预览：圆点旁浮出「层级 · 标题」 */
	showRailTip(anchor, text) {
		let tip = this.railTip;
		if (!anchor) { if (tip) tip.remove(); this.railTip = null; return; }
		if (!tip) {
			tip = document.createElement('div');
			tip.className = 'muyun-rail-tip';
			this.railEl.appendChild(tip);
			this.railTip = tip;
		}
		tip.textContent = text;
		tip.style.top = (anchor.offsetTop - 4) + 'px';
	}

	/* 小地图 ↔ 大纲联动：跳转后让大纲面板的当前项滚入视野（is-active 由核心大纲维护） */
	pulseOutline() {
		setTimeout(() => {
			this.app.workspace.getLeavesOfType('outline').forEach(function (leaf) {
				const active = leaf.view && leaf.view.contentEl
					? leaf.view.contentEl.querySelector('.tree-item-self.is-active')
					: null;
				if (active) active.scrollIntoView({ block: 'nearest' });
			});
		}, 420);
	}

	/* ═══ 续读记忆：按路径记住滚动比，重开自动回位；附带已读轨迹持久化 ═══ */
	loadStore() {
		try { this.store = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; }
		catch (e) { this.store = {}; }
	}

	saveStoreSoon() {
		clearTimeout(this._storeT);
		this._storeT = setTimeout(() => {
			localStorage.setItem(STORE_KEY, JSON.stringify(this.store));
		}, 400);
	}

	pruneStore() {
		const keys = Object.keys(this.store);
		if (keys.length <= STORE_MAX) return;
		keys.sort((a, b) => (this.store[a].ts || 0) - (this.store[b].ts || 0));
		while (keys.length > STORE_MAX) delete this.store[keys.shift()];
	}

	saveCurrentPosSoon() {
		clearTimeout(this._posT);
		this._posT = setTimeout(() => this.saveCurrentPos(), 600);
	}

	saveCurrentPos() {
		if (!this.settings.resumeReading) return;
		const file = this.app.workspace.getActiveFile();
		const el = this.scrollElOf(this.activeMarkdownView());
		if (!file || !el) return;
		const max = el.scrollHeight - el.clientHeight;
		const rec = this.store[file.path] || (this.store[file.path] = { ts: 0 });
		if (max > 4) rec.ratio = Math.min(1, Math.max(0, el.scrollTop / max));
		rec.ts = Date.now();
		if (typeof this.railMaxRead === 'number' && this.railMaxRead >= 0) rec.readIdx = this.railMaxRead;
		this.pruneStore();
		this.saveStoreSoon();
	}

	restoreFor(file) {
		if (!this.settings.resumeReading || !file) return;
		const rec = this.store[file.path];
		if (!rec || !rec.ratio) return;
		const self = this;
		let applied = 0;
		/* 两段式：350ms 首次施加；1000ms 时若用户未动滚动（ scrollTop 未变）则校正大笔记的渲染偏差 */
		const attempt = function (delay, verify) {
			setTimeout(function () {
				const f = self.app.workspace.getActiveFile();
				if (!f || f.path !== file.path) return;
				const el = self.scrollElOf(self.activeMarkdownView());
				if (!el) return;
				const max = el.scrollHeight - el.clientHeight;
				if (max <= 4) return;
				const target = Math.min(1, rec.ratio) * max;
				if (!verify) { el.scrollTop = target; applied = el.scrollTop; }
				else if (el.scrollTop === applied) { el.scrollTop = target; applied = el.scrollTop; }
			}, delay);
		};
		attempt(350, false);
		attempt(1000, true);
	}

	/* ═══ 状态栏：标题面包屑 + 阅读时长 ═══ */
	headingInfos(view) {
		if (!view) return [];
		const ce = view.contentEl;
		let els;
		if (view.getMode() === 'preview') {
			const pv = ce.querySelector('.markdown-preview-view');
			if (!pv) return [];
			els = Array.from(pv.querySelectorAll(HEADING_SEL));
		} else {
			els = Array.from(ce.querySelectorAll(
				'.cm-line.HyperMD-header-1, .cm-line.HyperMD-header-2, .cm-line.HyperMD-header-3, ' +
				'.cm-line.HyperMD-header-4, .cm-line.HyperMD-header-5, .cm-line.HyperMD-header-6'));
		}
		const preview = view.getMode() === 'preview';
		return els.map(function (el) {
			let level = 1;
			if (preview) level = +el.tagName[1];
			else {
				const m = /HyperMD-header-(\d)/.exec(el.className);
				if (m) level = +m[1];
			}
			return { el, level, text: (el.textContent || '').trim() };
		});
	}

	updateBreadcrumb() {
		if (!this.crumbEl) return;
		if (!this.settings.breadcrumb) {
			if (this._crumbText) { this.crumbEl.setText(''); this._crumbText = ''; }
			return;
		}
		const view = this.activeMarkdownView();
		const container = this.scrollElOf(view);
		const hs = this.headingInfos(view);
		if (!view || !container || !hs.length) {
			if (this._crumbText) { this.crumbEl.setText(''); this._crumbText = ''; }
			return;
		}

		const baseTop = container.getBoundingClientRect().top;
		let cur = 0;
		hs.forEach(function (h, i) {
			if (h.el.getBoundingClientRect().top - baseTop <= container.clientHeight * 0.35) cur = i;
		});

		/* 祖先链：从当前标题向上收集层级递减的标题，再确保自身在末位 */
		const chain = [];
		let lvl = 99;
		for (let i = cur; i >= 0; i--) {
			if (hs[i].level < lvl) { chain.unshift(hs[i]); lvl = hs[i].level; if (lvl === 1) break; }
		}
		if (chain[chain.length - 1] !== hs[cur]) chain.push(hs[cur]);

		let text = chain.map(function (c) { return c.text || '（无标题）'; }).join(' › ');
		if (text.length > 64) text = '…' + text.slice(-63);
		if (text !== this._crumbText) {
			this._crumbText = text;
			this.crumbEl.setText(text);
			this.crumbEl.setAttribute('title', text);
		}
	}

	computeReadTime() {
		if (!this.timeEl) return;
		if (!this.settings.readTime) { this.timeEl.setText(''); return; }
		const view = this.activeMarkdownView();
		if (!view) { this.timeEl.setText(''); return; }
		try {
			const text = view.editor.getValue();
			const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
			const words = (text.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9_'’-]+/g) || []).length;
			this.timeEl.setText('约 ' + Math.max(1, Math.round((cjk + words) / 400)) + ' 分钟');
		} catch (e) { /* 阅读态下编辑器暂不可用时静默跳过，等下一次触发 */ }
	}

	/* ═══ CM6 编辑器扩展：编辑态段落聚焦（默认关） + 打字机滚动（默认关） ═══ */
	buildCmExtension() {
		const plugin = this;
		const MuyunFocusPlugin = class {
			constructor(view) {
				this.view = view;
				this.decorations = this.build();
			}
			update(u) {
				if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = this.build();
				if (plugin.settings.typewriter && u.selectionSet) plugin.typewriterScroll(this.view);
			}
			build() {
				const view = this.view;
				const doc = view.state.doc;

				/* 编辑态段落聚焦（默认关）：光标所在空行分隔段落全亮，其余非空行淡出；框选时暂停 */
				if (plugin.settings.editorFocus) {
					const main = view.state.selection.main;
					if (main.empty) {
						const curLine = doc.lineAt(main.head).number;
						let s = curLine, e = curLine;
						while (s > 1 && doc.line(s - 1).text.trim()) s--;
						while (e < doc.lines && doc.line(e + 1).text.trim()) e++;
						const builder = new CM.RangeSetBuilder();
						for (let pos = view.viewport.from; pos <= view.viewport.to; ) {
							const line = doc.lineAt(pos);
							if ((line.number < s || line.number > e) && line.text.trim()) {
								builder.add(line.from, line.from, plugin.dimLineDeco);
							}
							pos = line.to + 1;
						}
						return builder.finish();
					}
					return CM.Decoration.none;
				}

				/* v0.3 实时预览聚光灯（默认关）：以光标所在标题节（行首 # 标题）为界，节外非空行淡出 */
				if (plugin.settings.spotlight) {
					const curLine = doc.lineAt(view.state.selection.main.head).number;
					let s = curLine, e = curLine;
					while (s > 1 && !/^#{1,6}\s/.test(doc.line(s - 1).text)) s--;
					while (e < doc.lines && !/^#{1,6}\s/.test(doc.line(e + 1).text)) e++;
					const builder = new CM.RangeSetBuilder();
					for (let pos = view.viewport.from; pos <= view.viewport.to; ) {
						const line = doc.lineAt(pos);
						if ((line.number < s || line.number > e) && line.text.trim()) {
							builder.add(line.from, line.from, plugin.dimLineDeco);
						}
						pos = line.to + 1;
					}
					return builder.finish();
				}
				return CM.Decoration.none;
			}
		};
		return [CM.ViewPlugin.fromClass(MuyunFocusPlugin, { decorations: v => v.decorations })];
	}

	typewriterScroll(view) {
		const head = view.state.selection.main.head;
		const coords = view.coordsAtPos(head);
		if (!coords) return;
		const rect = view.scrollDOM.getBoundingClientRect();
		const delta = coords.top - (rect.top + rect.height * 0.33);
		if (Math.abs(delta) > 24) view.scrollDOM.scrollTop += delta;
	}

	/* ═══ 收尾 ═══ */
	teardownExtras() { /* 预留 */ }
}

/* ── 设置页（分组：阅读 / 写作 / 全局） ── */
class MuyunCompanionSettingTab extends PluginSettingTab {
	display() {
		const { containerEl } = this;
		const p = this.plugin;
		containerEl.empty();

		containerEl.createEl('h3', { text: '阅读 Reading' });

		new Setting(containerEl)
			.setName('阅读进度条 · Reading progress (H1)')
			.setDesc('笔记顶部 4px 渐变细条，随滚动显示「读到哪了」。仅 Markdown 视图显示。')
			.addToggle(t => t.setValue(p.settings.progressBar)
				.onChange(async v => { p.settings.progressBar = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('阅读聚光灯 · Spotlight (H2)')
			.setDesc('当前小节全亮、其余降透明。阅读视图随滚动；实时预览随光标。观感争议项，默认关。')
			.addToggle(t => t.setValue(p.settings.spotlight)
				.onChange(async v => { p.settings.spotlight = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('聚光灯暗度 · Dim level')
			.setDesc('非当前小节的不透明度，越小越暗。')
			.addSlider(s => s.setLimits(0.15, 0.6, 0.05)
				.setValue(p.settings.spotlightDim)
				.setDynamicTooltip()
				.onChange(async v => { p.settings.spotlightDim = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('侧缘小地图 · Edge minimap (H8)')
			.setDesc('右缘标题点轨：阅读视图随滚动、实时预览随光标；点击圆点跳转。')
			.addToggle(t => t.setValue(p.settings.minimap)
				.onChange(async v => { p.settings.minimap = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('小地图已读轨迹 · Read trail')
			.setDesc('已到达过的小节圆点变为实心亮色，进度持久保存。')
			.addToggle(t => t.setValue(p.settings.minimapTrail)
				.onChange(async v => { p.settings.minimapTrail = v; await p.saveSettings(); p.refresh(); }));

		new Setting(containerEl)
			.setName('续读记忆 · Resume reading')
			.setDesc('按笔记记住上次读到的位置，重新打开自动回到原处。')
			.addToggle(t => t.setValue(p.settings.resumeReading)
				.onChange(async v => { p.settings.resumeReading = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('标题面包屑 · Breadcrumb')
			.setDesc('状态栏显示「章 › 节 › 小节」当前路径，随滚动更新。')
			.addToggle(t => t.setValue(p.settings.breadcrumb)
				.onChange(async v => { p.settings.breadcrumb = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('阅读时长估计 · Read time')
			.setDesc('状态栏显示「约 N 分钟」（按中文 400 字/分钟估算）。')
			.addToggle(t => t.setValue(p.settings.readTime)
				.onChange(async v => { p.settings.readTime = v; await p.saveSettings(); p.computeReadTime(); }));

		new Setting(containerEl)
			.setName('读完柔光 · Finish glow')
			.setDesc('单篇笔记首次读到结尾时，进度条柔光一次。')
			.addToggle(t => t.setValue(p.settings.finishGlow)
				.onChange(async v => { p.settings.finishGlow = v; await p.saveSettings(); }));

		containerEl.createEl('h3', { text: '写作 Writing' });

		new Setting(containerEl)
			.setName('编辑态段落聚焦 · Paragraph focus')
			.setDesc('光标所在段落全亮、其余段落淡出（框选时自动暂停）。默认关。')
			.addToggle(t => t.setValue(p.settings.editorFocus)
				.onChange(async v => { p.settings.editorFocus = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('打字机滚动 · Typewriter scrolling')
			.setDesc('光标始终保持在屏幕上三分之一处。默认关。')
			.addToggle(t => t.setValue(p.settings.typewriter)
				.onChange(async v => { p.settings.typewriter = v; await p.saveSettings(); }));

		containerEl.createEl('h3', { text: '说明 Notes' });
		const notes = containerEl.createEl('p', {
			text: '聚光灯与小地图仅阅读视图生效；编辑态效果依赖 CodeMirror（不支持时自动禁用）。' +
				'进度条与小地图颜色跟随主题交互色（MuYun 下即你的 accent 体系）。' +
				'所有效果均可用命令面板「切换…」或快捷键控制。'
		});
		notes.style.cssText = 'color:var(--text-muted);font-size:12px;';
	}
}

module.exports = MuyunCompanionPlugin;
