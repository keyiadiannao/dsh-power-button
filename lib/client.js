window.__ModuleLoader__.load({
	id: "dsh-restart-button",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/RestartButton.tsx
		/**
		* Sidebar footer power button + upward menu (重启 / 关机).
		*
		* The button geometry is a byte-for-byte replica of the adjacent Settings
		* trigger (ui-settings-general SettingsRoot.module.css .trigger): 34px compact
		* row, `calc(100% + 8px)` width with -4px side margins, 8px icon gap, 10px
		* left padding, 22px line-height, 16px icon, radius and theme-token hover.
		* Driven by DSH theme tokens — follows light/dark automatically. Clicking
		* opens an upward menu anchored above the button; picking an action starts
		* the full-screen restart/shutdown overlay.
		*/
		const MENU_W = 220;
		function RestartButton(props) {
			const [open, setOpen] = (0, react.useState)(false);
			const btnRef = (0, react.useRef)(null);
			const menuRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onDown = (e) => {
					const t = e.target;
					if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
					setOpen(false);
				};
				const onKey = (e) => {
					if (e.key === "Escape") setOpen(false);
				};
				document.addEventListener("mousedown", onDown);
				document.addEventListener("keydown", onKey);
				return () => {
					document.removeEventListener("mousedown", onDown);
					document.removeEventListener("keydown", onKey);
				};
			}, [open]);
			const pick = (action) => {
				setOpen(false);
				beginPower(action);
			};
			const MENU_H = 84;
			const anchor = () => {
				const r = btnRef.current?.getBoundingClientRect();
				if (!r) return { display: "none" };
				return {
					position: "fixed",
					left: Math.max(8, r.right - MENU_W),
					top: Math.max(8, r.top - 8 - MENU_H),
					width: MENU_W
				};
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				ref: btnRef,
				type: "button",
				onClick: () => setOpen((o) => !o),
				"aria-haspopup": "menu",
				"aria-expanded": open,
				title: "电源（重启 / 关机）",
				style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					width: "calc(100% + 8px)",
					minWidth: 0,
					height: 34,
					margin: "4px -4px 4px",
					boxSizing: "border-box",
					padding: "6px 2px 6px 10px",
					flex: "none",
					border: "none",
					borderRadius: 12,
					background: open ? "var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.06))" : "transparent",
					color: "var(--dsw-alias-label-primary, #f2f6fc)",
					font: "inherit",
					fontSize: 14,
					lineHeight: "22px",
					cursor: "pointer",
					textAlign: "left",
					overflow: "hidden",
					transition: "background 0.15s ease"
				},
				onMouseEnter: (e) => {
					e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))";
				},
				onMouseLeave: (e) => {
					if (!open) e.currentTarget.style.background = "transparent";
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width: "16",
					height: "16",
					viewBox: "0 0 24 24",
					fill: "none",
					"aria-hidden": "true",
					style: { flex: "0 0 auto" },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M12 3v8",
						stroke: "currentColor",
						strokeWidth: "2.4",
						strokeLinecap: "round"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M7.5 5.6a8 8 0 1 0 9 0",
						stroke: "currentColor",
						strokeWidth: "2.4",
						strokeLinecap: "round"
					})]
				}), props.wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "电源" })]
			}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: menuRef,
				role: "menu",
				"aria-label": "电源",
				style: {
					...anchor(),
					zIndex: 1500,
					boxSizing: "border-box",
					padding: 6,
					borderRadius: 12,
					background: "var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.97))",
					border: "1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))",
					boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
					backdropFilter: "blur(12px)",
					WebkitBackdropFilter: "blur(12px)",
					fontFamily: "inherit",
					fontSize: 14,
					color: "var(--dsw-alias-label-primary, #f2f6fc)"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MenuItem, {
					label: "重启",
					title: "重新启动 DeepSeek Harness",
					onClick: () => pick("restart"),
					glyph: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
						width: "15",
						height: "15",
						viewBox: "0 0 24 24",
						fill: "none",
						"aria-hidden": "true",
						style: { flex: "0 0 auto" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M20 12a8 8 0 1 1-2.34-5.66",
							stroke: "currentColor",
							strokeWidth: "2.2",
							strokeLinecap: "round"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M20 3v4h-4",
							stroke: "currentColor",
							strokeWidth: "2.2",
							strokeLinecap: "round",
							strokeLinejoin: "round"
						})]
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(MenuItem, {
					label: "关机",
					title: "停止 DeepSeek Harness，之后需手动启动",
					onClick: () => pick("shutdown"),
					glyph: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
						width: "15",
						height: "15",
						viewBox: "0 0 24 24",
						fill: "none",
						"aria-hidden": "true",
						style: { flex: "0 0 auto" },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M12 3v8",
							stroke: "currentColor",
							strokeWidth: "2.2",
							strokeLinecap: "round"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
							d: "M7.5 5.6a8 8 0 1 0 9 0",
							stroke: "currentColor",
							strokeWidth: "2.2",
							strokeLinecap: "round"
						})]
					})
				})]
			}) : null] });
		}
		function MenuItem({ label, title, onClick, glyph }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				role: "menuitem",
				title,
				onClick,
				style: {
					display: "flex",
					alignItems: "center",
					gap: 10,
					width: "100%",
					boxSizing: "border-box",
					padding: "7px 10px",
					border: "none",
					borderRadius: 8,
					background: "transparent",
					color: "var(--dsw-alias-label-primary, #f2f6fc)",
					font: "inherit",
					fontSize: 14,
					lineHeight: "22px",
					cursor: "pointer",
					textAlign: "left",
					whiteSpace: "nowrap",
					transition: "background 0.12s ease"
				},
				onMouseEnter: (e) => {
					e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))";
				},
				onMouseLeave: (e) => {
					e.currentTarget.style.background = "transparent";
				},
				children: [glyph, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: {
						display: "block",
						lineHeight: "22px",
						whiteSpace: "nowrap",
						flex: "none"
					},
					children: label
				})]
			});
		}
		//#endregion
		//#region src/client/RestartOverlay.tsx
		const RING_R = 52;
		const RING_C = 2 * Math.PI * RING_R;
		const VEIL = {
			position: "fixed",
			inset: 0,
			zIndex: 2e3,
			display: "flex",
			flexDirection: "column",
			alignItems: "center",
			justifyContent: "center",
			gap: 28,
			background: "rgba(8, 12, 20, 0.82)",
			backdropFilter: "blur(10px)",
			WebkitBackdropFilter: "blur(10px)",
			color: "#eef2f9",
			fontFamily: "ui-sans-serif, system-ui, -apple-system, \"Segoe UI\", \"Microsoft YaHei\", sans-serif",
			userSelect: "none"
		};
		const RING_WRAP = {
			position: "relative",
			width: 148,
			height: 148
		};
		/** Every ring layer (track, progress, sweep) pins to the 148×148 box. */
		const RING_LAYER = {
			position: "absolute",
			top: 0,
			left: 0
		};
		const POWER_BTN = {
			position: "absolute",
			inset: 0,
			borderRadius: "50%",
			border: "1px solid rgba(255,255,255,0.14)",
			background: "rgba(255,255,255,0.04)",
			cursor: "pointer",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			transition: "background 0.2s ease, border-color 0.2s ease"
		};
		const CAPTION = {
			fontSize: 17,
			fontWeight: 500,
			letterSpacing: .3,
			color: "#eef2f9",
			textAlign: "center",
			minHeight: 26
		};
		const SUB = {
			fontSize: 13,
			color: "rgba(238,242,249,0.55)",
			textAlign: "center",
			maxWidth: 360,
			lineHeight: 1.6
		};
		const ACTION_ROW = {
			display: "flex",
			gap: 12
		};
		function ActionButton({ label, danger, onClick, disabled }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				onClick,
				disabled,
				style: {
					padding: "9px 26px",
					borderRadius: 8,
					border: danger ? "1px solid rgba(255,133,146,0.5)" : "1px solid rgba(255,255,255,0.18)",
					background: danger ? "rgba(255,133,146,0.12)" : "rgba(255,255,255,0.06)",
					color: danger ? "#ff8592" : "#eef2f9",
					fontSize: 14,
					fontWeight: 600,
					cursor: disabled ? "default" : "pointer",
					opacity: disabled ? .5 : 1,
					transition: "background 0.2s ease"
				},
				children: label
			});
		}
		function PowerGlyph({ size = 40 }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": "true",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M12 3v8",
					stroke: "currentColor",
					strokeWidth: "2.2",
					strokeLinecap: "round"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
					d: "M7.5 5.6a8 8 0 1 0 9 0",
					stroke: "currentColor",
					strokeWidth: "2.2",
					strokeLinecap: "round"
				})]
			});
		}
		function RestartOverlay(_props) {
			const phase = (0, react.useSyncExternalStore)(onRestartChange, getRestartPhase);
			const action = (0, react.useSyncExternalStore)(onRestartChange, getPowerAction);
			const error = (0, react.useSyncExternalStore)(onRestartChange, getRestartError);
			if (phase === "idle") return null;
			const busy = phase === "shutting" || phase === "waiting" || phase === "recovering";
			const shuttingDown = action === "shutdown";
			const ringDash = RING_C * (1 - ({
				shutting: .22,
				waiting: .58,
				recovering: 1,
				off: 1,
				error: .9
			}[phase] ?? 0));
			const ringStyle = {
				transform: "rotate(-90deg)",
				transformOrigin: "center"
			};
			if (busy) ringStyle.animation = "dsh-restart-sweep 1.8s linear infinite";
			const captions = shuttingDown ? {
				shutting: "正在关机 DeepSeek Harness…",
				waiting: "正在关机…",
				recovering: "正在恢复…",
				off: "已关机",
				error: "关机出现问题"
			} : {
				shutting: "正在关闭 DeepSeek Harness…",
				waiting: "正在重启…",
				recovering: "正在恢复…",
				error: "重启出现问题"
			};
			const subs = shuttingDown ? {
				shutting: "正在结束进程，即将断开连接",
				waiting: "等待进程退出",
				recovering: "正在恢复…",
				off: "可以关闭此页面了；需要时请手动重新启动 DSH",
				error: error ?? "未知错误"
			} : {
				shutting: "正在结束进程，即将断开连接",
				waiting: "等待旧进程退出，新实例即将启动",
				recovering: "新实例已就绪，正在刷新页面",
				error: error ?? "未知错误"
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: VEIL,
				role: "dialog",
				"aria-label": shuttingDown ? "关机 DeepSeek Harness" : "重启 DeepSeek Harness",
				"aria-busy": busy,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: `
        @keyframes dsh-restart-sweep {
          0%   { transform: rotate(-90deg); }
          100% { transform: rotate(270deg); }
        }
        @keyframes dsh-restart-fade {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes dsh-restart-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.45; }
        }
      ` }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: RING_WRAP,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
								width: 148,
								height: 148,
								style: {
									...RING_LAYER,
									transform: "rotate(-90deg)",
									transformOrigin: "center"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "74",
									cy: "74",
									r: RING_R,
									fill: "none",
									stroke: "rgba(255,255,255,0.08)",
									strokeWidth: "5"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "74",
									cy: "74",
									r: RING_R,
									fill: "none",
									stroke: phase === "error" ? "#ff8592" : "#4f8cff",
									strokeWidth: "5",
									strokeLinecap: "round",
									strokeDasharray: RING_C,
									strokeDashoffset: ringDash,
									style: { transition: "stroke-dashoffset 1.1s cubic-bezier(0.4, 0, 0.2, 1)" }
								})]
							}),
							busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
								width: 148,
								height: 148,
								style: {
									...RING_LAYER,
									...ringStyle
								},
								"aria-hidden": "true",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "74",
									cy: "74",
									r: RING_R,
									fill: "none",
									stroke: "rgba(79,140,255,0.5)",
									strokeWidth: "5",
									strokeLinecap: "round",
									strokeDasharray: `${RING_C * .18} ${RING_C * .82}`
								})
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: POWER_BTN,
								tabIndex: -1,
								"aria-hidden": !busy,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										color: phase === "error" ? "#ff8592" : "#eef2f9",
										animation: busy ? "dsh-restart-pulse 2s ease-in-out infinite" : void 0
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(PowerGlyph, {})
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...CAPTION,
							animation: "dsh-restart-fade 0.35s ease"
						},
						children: captions[phase]
					}, phase),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...SUB,
							animation: "dsh-restart-fade 0.35s ease 0.08s both"
						},
						children: subs[phase]
					}, `sub-${phase}`),
					phase === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...ACTION_ROW,
							animation: "dsh-restart-fade 0.35s ease 0.15s both"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							label: "重试",
							onClick: () => beginPower(action)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							label: "关闭",
							danger: true,
							onClick: () => window.location.reload()
						})]
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services. */
		const inject = ["slots"];
		let phase = "idle";
		let action = "restart";
		let errorMsg = null;
		const listeners = /* @__PURE__ */ new Set();
		function emit() {
			for (const fn of listeners) fn();
		}
		function getRestartPhase() {
			return phase;
		}
		function getPowerAction() {
			return action;
		}
		function getRestartError() {
			return errorMsg;
		}
		/** Surface an error, unless the flow has already moved past the point of no return. */
		function fail(msg) {
			if (phase === "error" || phase === "recovering") return;
			phase = "error";
			errorMsg = msg;
			emit();
		}
		/** Kick a restart or shutdown. Opens the overlay and drives the flow. */
		function beginPower(next) {
			action = next;
			phase = "shutting";
			errorMsg = null;
			emit();
			fetch(next === "shutdown" ? "/api/dsh-restart-button/shutdown" : "/api/dsh-restart-button/restart", {
				method: "POST",
				keepalive: true
			}).then(async (r) => {
				const j = await r.json().catch(() => ({}));
				if (!r.ok || j?.ok === false) fail(j?.error ?? `操作失败 (HTTP ${r.status})`);
			}).catch(() => {});
			if (next === "shutdown") {
				let attempts = 0;
				const timer = setInterval(async () => {
					attempts += 1;
					if (attempts >= 40) {
						clearInterval(timer);
						phase = "off";
						emit();
						return;
					}
					let up = false;
					try {
						up = (await fetch("/api/dsh-restart-button/health", { cache: "no-store" })).ok;
					} catch {
						up = false;
					}
					if (!up) {
						clearInterval(timer);
						phase = "off";
						emit();
					}
				}, 500);
				return;
			}
			setTimeout(() => {
				if (phase === "shutting") {
					phase = "waiting";
					emit();
				}
			}, 600);
			let seenDown = false;
			let upTicks = 0;
			let attempts = 0;
			const timer = setInterval(async () => {
				attempts += 1;
				if (attempts >= 90) {
					clearInterval(timer);
					phase = "error";
					errorMsg = "重启超时，请手动刷新";
					emit();
					return;
				}
				let up = false;
				try {
					up = (await fetch("/api/dsh-restart-button/health", { cache: "no-store" })).ok;
				} catch {
					up = false;
				}
				if (!up) {
					seenDown = true;
					upTicks = 0;
					if (phase !== "waiting") {
						phase = "waiting";
						emit();
					}
					return;
				}
				if (seenDown) {
					clearInterval(timer);
					phase = "recovering";
					emit();
					setTimeout(() => window.location.reload(), 1300);
					return;
				}
				upTicks += 1;
				if (upTicks >= 20) {
					clearInterval(timer);
					phase = "error";
					errorMsg = "重启未生效，请重试";
					emit();
				}
			}, 1e3);
		}
		/** Subscribe to power-flow changes; returns an unsubscribe. */
		function onRestartChange(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		}
		function apply(ctx) {
			const styleEl = document.createElement("style");
			styleEl.textContent = "[class$=\"_footerActions\"] { flex-wrap: wrap; }";
			document.head.appendChild(styleEl);
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-restart-button",
				order: -20,
				label: () => "电源"
			}, RestartButton));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-restart-overlay"
			}, RestartOverlay));
		}
		//#endregion
		exports.apply = apply;
		exports.beginPower = beginPower;
		exports.getPowerAction = getPowerAction;
		exports.getRestartError = getRestartError;
		exports.getRestartPhase = getRestartPhase;
		exports.inject = inject;
		exports.onRestartChange = onRestartChange;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map