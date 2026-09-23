'use strict';

/* MuYun Companion · v0.1.0
   MuYun 慕云主题的配套增强插件，承载主题（纯 CSS）无法实现的三项 JS 效果：
   H1 顶部阅读进度条 / H2 阅读聚光灯（默认关）/ H8 侧缘小地图点轨。
   纯 JavaScript（无构建链），CommonJS 引用运行时 obsidian 模块。
   设计文档：《MuYun 设计文档 v0.3》§7；样式走主题 CSS 变量，主题缺席时优雅降级。 */

const { Plugin, PluginSettingTab, Setting, MarkdownView, Notice, debounce } = require('obsidian');

const DEFAULT_SETTINGS = {
	progressBar: true,      /* H1 顶部阅读进度条 */
	minimap: true,          /* H8 侧缘小地图点轨 */
	spotlight: false,       /* H2 阅读聚光灯（观感争议项，默认关） */
	spotlightDim: 0.35      /* 聚光灯暗度：非当前小节的不透明度 */
};

const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';
const HEADING_SCOPE_SEL = HEADING_SEL.split(', ').map(function (s) { return ':scope > ' + s; }).join(', ');

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
		this.railHeads = [];
		this.dimContainer = null;
		this.dimBlocks = [];
		this.raf = 0;

		this.addSettingTab(new MuyunCompanionSettingTab(this.app, this));

		this.addCommand({
			name: '切换阅读进度条',
			callback: () => this.toggle('progressBar')
		});
		this.addCommand({
			name: '切换阅读聚光灯',
			callback: () => this.toggle('spotlight')
		});
		this.addCommand({
			name: '切换侧缘小地图',
			callback: () => this.toggle('minimap')
		});

		/* H1 进度条挂在 body 上，全生命周期存在，按需显隐 */
		this.initBar();

		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refresh()));
		this.registerEvent(this.app.workspace.on('layout-change', debounce(() => this.refresh(), 150, true)));
		this.registerEvent(this.app.workspace.on('editor-change', debounce(() => this.refreshSoft(), 800, true)));
		this.registerDomEvent(window, 'resize', () => this.updateProgress());
		this.registerDomEvent(document, 'scroll', () => this.onScroll(), { capture: true, passive: true });

		this.refresh();
	}

	onunload() {
		this.teardownBar();
		this.clearRail();
		this.clearDim();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refresh();
	}

	toggle(key) {
		this.settings[key] = !this.settings[key];
		this.saveSettings();
		new Notice('MuYun Companion：' + this.label(key) + '已' + (this.settings[key] ? '开启' : '关闭'));
	}

	label(key) {
		return { progressBar: '阅读进度条', spotlight: '阅读聚光灯', minimap: '侧缘小地图' }[key] || key;
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
	}

	refreshSoft() {
		this.updateProgress();
		if (this.settings.minimap) this.buildRail();
		if (this.settings.spotlight) this.applySpotlight();
	}

	onScroll() {
		if (this.raf) return;
		this.raf = requestAnimationFrame(() => {
			this.raf = 0;
			this.updateProgress();
			this.applySpotlight();
			this.updateRail();
		});
	}

	/* ── H1 顶部阅读进度条 ── */
	initBar() {
		this.barEl = document.createElement('div');
		this.barEl.className = 'muyun-progress';
		this.barFill = document.createElement('div');
		this.barFill.className = 'muyun-progress-fill';
		this.barEl.appendChild(this.barFill);
		document.body.appendChild(this.barEl);
		this.register(() => this.barEl.remove());
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
	}

	/* ── H2 阅读聚光灯（仅阅读视图；当前小节全亮，其余降透明） ── */
	clearDim() {
		this.dimBlocks.forEach(function (b) { b.classList.remove('muyun-dim'); });
		this.dimBlocks = [];
		this.dimContainer = null;
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

		const blocks = this.resolveBlocks(previewEl);
		if (!blocks.length) return;

		/* 定位当前小节：以视口上 35% 为 reading line，取其上方最近的标题块 */
		const baseTop = previewEl.getBoundingClientRect().top;
		const heads = [];
		blocks.forEach(function (b, i) { if (isHeadingBlock(b)) heads.push(i); });
		let active = 0;
		heads.forEach(function (idx, k) {
			const top = blocks[idx].getBoundingClientRect().top - baseTop;
			if (top <= previewEl.clientHeight * 0.35) active = k;
		});
		const from = heads.length ? heads[active] : 0;
		const to = heads.length && active + 1 < heads.length ? heads[active + 1] : blocks.length;

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

	/* ── H8 侧缘小地图点轨（仅阅读视图；跟随滚动 + 点击跳转） ── */
	clearRail() {
		if (this.railEl) this.railEl.remove();
		if (this.railView) this.railView.contentEl.classList.remove('muyun-has-rail');
		this.railEl = null;
		this.railView = null;
		this.railHeads = [];
	}

	buildRail() {
		const view = this.activeMarkdownView();
		const previewEl = view && view.getMode() === 'preview'
			? view.contentEl.querySelector('.markdown-preview-view')
			: null;
		if (!this.settings.minimap || !previewEl) { this.clearRail(); return; }
		if (this.railEl && this.railEl.parentElement !== view.contentEl) this.clearRail();

		const heads = Array.from(previewEl.querySelectorAll(HEADING_SEL));
		if (!heads.length) { this.clearRail(); return; }

		if (!this.railEl) {
			this.railEl = document.createElement('div');
			this.railEl.className = 'muyun-rail';
			view.contentEl.classList.add('muyun-has-rail');
			view.contentEl.appendChild(this.railEl);
			this.railView = view;
			this.register(() => this.clearRail());
		}

		/* 内容变化时重建点轨 */
		if (this.railHeads.length !== heads.length) {
			this.railEl.innerHTML = '';
			this.railHeads = heads;
			const self = this;
			heads.forEach(function (h) {
				const b = document.createElement('button');
				b.className = 'muyun-rail-dot lvl' + h.tagName[1];
				b.setAttribute('aria-label', (h.textContent || '').trim().slice(0, 48));
				b.addEventListener('click', function () {
					h.scrollIntoView({ behavior: 'smooth', block: 'start' });
				});
				self.railEl.appendChild(b);
			});
		}
		this.updateRail();
	}

	updateRail() {
		if (!this.railEl || !this.railHeads.length || !this.railView) return;
		const previewEl = this.railView.contentEl.querySelector('.markdown-preview-view');
		if (!previewEl) return;
		const baseTop = previewEl.getBoundingClientRect().top;
		let cur = 0;
		this.railHeads.forEach(function (h, i) {
			if (h.getBoundingClientRect().top - baseTop <= previewEl.clientHeight * 0.35) cur = i;
		});
		const dots = this.railEl.querySelectorAll('button');
		dots.forEach(function (b, i) { b.classList.toggle('cur', i === cur); });
	}
}

/* ── 设置页 ── */
class MuyunCompanionSettingTab extends PluginSettingTab {
	display() {
		const { containerEl } = this;
		containerEl.empty();
		const p = this.plugin;

		new Setting(containerEl)
			.setName('阅读进度条（H1）')
			.setDesc('笔记顶部 3px 细条，随滚动显示「读到哪了」。仅 Markdown 视图显示。')
			.addToggle(t => t.setValue(p.settings.progressBar)
				.onChange(async v => { p.settings.progressBar = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('阅读聚光灯（H2）')
			.setDesc('阅读视图下当前小节全亮、其余降透明。观感争议项，默认关。仅阅读视图生效。')
			.addToggle(t => t.setValue(p.settings.spotlight)
				.onChange(async v => { p.settings.spotlight = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('聚光灯暗度')
			.setDesc('非当前小节的不透明度，越小越暗。')
			.addSlider(s => s.setLimits(0.15, 0.6, 0.05)
				.setValue(p.settings.spotlightDim)
				.setDynamicTooltip()
				.onChange(async v => { p.settings.spotlightDim = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('侧缘小地图（H8）')
			.setDesc('笔记右缘标题点轨：跟随滚动高亮当前小节，点击圆点跳转。仅阅读视图生效。')
			.addToggle(t => t.setValue(p.settings.minimap)
				.onChange(async v => { p.settings.minimap = v; await p.saveSettings(); }));

		new Setting(containerEl)
			.setName('说明')
			.setDesc('进度条颜色跟随主题交互色（MuYun 下即你的 accent 体系）。三项均可用命令面板「切换…」或快捷键控制。编辑（实时预览）模式下聚光灯与小地图不显示。');
	}
}

module.exports = MuyunCompanionPlugin;
