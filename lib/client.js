window.__ModuleLoader__.load({
	id: "dsh-restart-button",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/ShutdownConfirm.tsx
		/**
		* Shared modal confirm dialog for the irreversible shutdown action. Used both
		* by the power-button menu (RestartButton) and by the `/shutdown` command path
		* (client/index.ts listens for the SHUTDOWN_CONFIRM_PENDING signal and shows
		* this same dialog before POSTing /api/dsh-restart-button/shutdown).
		*/
		/** Fully self-contained: styled with DSH design tokens, own focus trap and Esc handling. */
		function ShutdownConfirm({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }) {
			const cancelRef = (0, react.useRef)(null);
			const onKey = (e) => {
				if (e.key === "Escape") onCancel();
			};
			(0, react.useEffect)(() => {
				cancelRef.current?.focus();
				document.addEventListener("keydown", onKey);
				return () => document.removeEventListener("keydown", onKey);
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				role: "dialog",
				"aria-modal": "true",
				"aria-label": title,
				onMouseDown: (e) => {
					if (e.target === e.currentTarget) onCancel();
				},
				style: {
					position: "fixed",
					inset: 0,
					zIndex: 1600,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					background: "var(--dsw-alias-bg-mask-2, rgba(0,0,0,0.4))",
					backdropFilter: "blur(2px)",
					WebkitBackdropFilter: "blur(2px)",
					fontFamily: "var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						width: 320,
						boxSizing: "border-box",
						padding: "20px 22px 18px",
						borderRadius: 14,
						background: "var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.98))",
						border: "1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))",
						boxShadow: "0 16px 48px rgba(0,0,0,0.45)",
						color: "var(--dsw-alias-label-primary, #f2f6fc)"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 15,
								fontWeight: 650,
								lineHeight: 1.4,
								marginBottom: 8
							},
							children: title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 13,
								lineHeight: 1.6,
								color: "var(--dsw-alias-label-secondary, rgba(242,246,252,0.7))",
								marginBottom: 18
							},
							children: body
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								justifyContent: "flex-end",
								gap: 10
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								ref: cancelRef,
								type: "button",
								onClick: onCancel,
								style: {
									padding: "7px 16px",
									borderRadius: 8,
									border: "1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.31))",
									background: "transparent",
									color: "var(--dsw-alias-label-primary, #f2f6fc)",
									font: "inherit",
									fontSize: 13,
									cursor: "pointer"
								},
								children: cancelLabel
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								onClick: onConfirm,
								style: {
									padding: "7px 16px",
									borderRadius: 8,
									border: "1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent)",
									background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, var(--dsw-alias-bg-layer-2, rgba(24,28,38,0.98)))",
									color: "var(--dsw-alias-state-error-primary, #ff8592)",
									font: "inherit",
									fontSize: 13,
									fontWeight: 600,
									cursor: "pointer"
								},
								children: confirmLabel
							})]
						})
					]
				})
			});
		}
		//#endregion
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
			const { t } = props;
			const [open, setOpen] = (0, react.useState)(false);
			const [confirming, setConfirming] = (0, react.useState)(false);
			const btnRef = (0, react.useRef)(null);
			const menuRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (!open) return;
				(menuRef.current?.querySelector("[role=\"menuitem\"]"))?.focus();
				const onDown = (e) => {
					const t = e.target;
					if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
					setOpen(false);
					btnRef.current?.focus();
				};
				const onKey = (e) => {
					if (e.key === "Escape") {
						setOpen(false);
						btnRef.current?.focus();
						return;
					}
					if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
					e.preventDefault();
					const items = [...menuRef.current?.querySelectorAll("[role=\"menuitem\"]") ?? []];
					const idx = items.indexOf(document.activeElement);
					const delta = e.key === "ArrowDown" ? 1 : -1;
					if (items.length === 0) return;
					items[(idx + delta + items.length) % items.length]?.focus();
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
				if (action === "shutdown") {
					setConfirming(true);
					return;
				}
				beginPower("restart");
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
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					ref: btnRef,
					type: "button",
					className: "dsh-restart-button",
					onClick: () => setOpen((o) => !o),
					"aria-haspopup": "menu",
					"aria-expanded": open,
					title: t("powerTitle"),
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
					}), props.wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("power") })]
				}),
				open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					ref: menuRef,
					role: "menu",
					"aria-label": t("power"),
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
						label: t("restart"),
						title: t("restartHint"),
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
						label: t("shutdown"),
						title: t("shutdownHint"),
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
				}) : null,
				confirming ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ShutdownConfirm, {
					title: t("shutdownConfirmTitle"),
					body: t("shutdownConfirmBody"),
					confirmLabel: t("confirmShutdown"),
					cancelLabel: t("cancel"),
					onConfirm: () => {
						setConfirming(false);
						beginPower("shutdown");
					},
					onCancel: () => setConfirming(false)
				}) : null
			] });
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
		//#region src/client/RestartNotice.tsx
		/** How long the toast stays visible before fading out. */
		const TOAST_MS = 4500;
		/** Health endpoint the toast consults once at mount. */
		const HEALTH = "/api/dsh-restart-button/health";
		/** ACK endpoint that clears the in-memory restart confirmation. */
		const ACK = "/api/dsh-restart-button/notice-shown";
		/** Static styles. All colors reference the ui-theme design tokens on `body`,
		* so light/dark and any future palette changes are picked up automatically.
		* React.CSSProperties accepts `var(--x)` strings for color-ish properties. */
		const WRAP = {
			position: "fixed",
			bottom: 32,
			left: "50%",
			zIndex: 1800,
			display: "flex",
			alignItems: "center",
			gap: 12,
			padding: "12px 16px 12px 12px",
			borderRadius: 12,
			background: "var(--dsw-alias-toast-bg, #1c2433)",
			border: "1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.12))",
			boxShadow: "0 12px 40px rgba(0, 0, 0, 0.4), 0 1px 0 rgba(255,255,255,0.06) inset",
			color: "var(--dsw-alias-label-primary, #eef2f9)",
			fontFamily: "var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)",
			fontSize: 13,
			userSelect: "none",
			animation: "dsh-restart-toast-in 0.35s cubic-bezier(0.21, 1.02, 0.45, 1)"
		};
		const BADGE = {
			width: 30,
			height: 30,
			borderRadius: "50%",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			flexShrink: 0,
			background: "var(--dsw-alias-state-business-tertiary, rgba(65, 118, 230, 0.16))",
			border: "1px solid var(--dsw-alias-state-business-primary, rgba(65, 118, 230, 0.4))"
		};
		const BODY = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		const CAPTION$1 = {
			fontWeight: 600,
			fontSize: 14,
			letterSpacing: .2,
			lineHeight: 1.3
		};
		const SUB$1 = {
			color: "var(--dsw-alias-label-secondary, rgba(238,242,249,0.6))",
			fontSize: 12,
			lineHeight: 1.4
		};
		const CLOSE = {
			alignSelf: "flex-start",
			border: "none",
			background: "transparent",
			color: "var(--dsw-alias-label-caption, rgba(238,242,249,0.45))",
			fontSize: 14,
			lineHeight: 1,
			padding: "2px 4px",
			cursor: "pointer",
			borderRadius: 6,
			transition: "color 0.15s ease, background 0.15s ease"
		};
		/** Fade the toast out in place (no movement), then unmount. */
		const OUT = { animation: "dsh-restart-toast-out 0.25s ease forwards" };
		/** A self-contained toast: queries /health once, renders while visible,
		* ACKs when dismissed. No module-level state — the component owns its whole
		* lifecycle, so hot reload and re-mounts behave predictably. */
		function RestartNotice(props) {
			const { t } = props;
			const [visible, setVisible] = (0, react.useState)(false);
			const [leaving, setLeaving] = (0, react.useState)(false);
			const acked = (0, react.useRef)(false);
			const timerRef = (0, react.useRef)(void 0);
			const ack = () => {
				if (acked.current) return;
				acked.current = true;
				fetch(ACK, {
					method: "POST",
					keepalive: true
				}).catch(() => {});
			};
			const dismiss = () => {
				if (timerRef.current !== void 0) clearTimeout(timerRef.current);
				ack();
				setLeaving(true);
				setTimeout(() => setVisible(false), 280);
			};
			(0, react.useEffect)(() => {
				let cancelled = false;
				(async () => {
					let restarted = false;
					try {
						const r = await fetch(HEALTH, { cache: "no-store" });
						if (r.ok) restarted = (await r.json().catch(() => ({}))).restarted === true;
					} catch {}
					if (cancelled || !restarted) return;
					setVisible(true);
					timerRef.current = setTimeout(dismiss, TOAST_MS);
				})();
				return () => {
					cancelled = true;
					if (timerRef.current !== void 0) clearTimeout(timerRef.current);
					ack();
				};
			}, []);
			if (!visible) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "status",
				"aria-live": "polite",
				style: leaving ? {
					...WRAP,
					...OUT
				} : WRAP,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: `
        @keyframes dsh-restart-toast-in {
          from { opacity: 0; transform: translateX(-50%) translateY(14px) scale(0.96); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        }
        @keyframes dsh-restart-toast-out {
          /* translateX(-50%) must persist: the wrapper's static style has no
             transform, so centering lives entirely in these keyframes — dropping
             it here would make the toast jump right by half its width. */
          from { opacity: 1; transform: translateX(-50%); }
          to   { opacity: 0; transform: translateX(-50%); }
        }
        @keyframes dsh-restart-check {
          from { stroke-dashoffset: 24; }
          to   { stroke-dashoffset: 0; }
        }
      ` }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: BADGE,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
							width: "15",
							height: "15",
							viewBox: "0 0 16 16",
							fill: "none",
							"aria-hidden": "true",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
								d: "M3.5 8.5 L6.5 11.5 L12.5 4.5",
								stroke: "var(--dsw-alias-state-business-primary, #4176e6)",
								strokeWidth: "2.2",
								strokeLinecap: "round",
								strokeLinejoin: "round",
								strokeDasharray: "24",
								strokeDashoffset: "24",
								style: { animation: "dsh-restart-check 0.4s ease 0.15s forwards" }
							})
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: BODY,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: CAPTION$1,
							children: t("restartedToast")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: SUB$1,
							children: t("restartedToastSub")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						"aria-label": t("close"),
						style: CLOSE,
						onClick: dismiss,
						onMouseEnter: (e) => {
							e.currentTarget.style.color = "var(--dsw-alias-label-primary, #eef2f9)";
							e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.08))";
						},
						onMouseLeave: (e) => {
							e.currentTarget.style.color = "var(--dsw-alias-label-caption, rgba(238,242,249,0.45))";
							e.currentTarget.style.background = "transparent";
						},
						children: "✕"
					})
				]
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
		function RestartOverlay(props) {
			const { t } = props;
			const phase = (0, react.useSyncExternalStore)(onRestartChange, getRestartPhase);
			const action = (0, react.useSyncExternalStore)(onRestartChange, getPowerAction);
			const error = (0, react.useSyncExternalStore)(onRestartChange, getRestartError);
			const dialogRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (phase === "idle") return;
				const retry = dialogRef.current?.querySelector("button");
				(phase === "error" && retry ? retry : dialogRef.current)?.focus();
			}, [phase]);
			if (phase === "idle" || phase === "preparing") return null;
			const busy = phase === "shutting" || phase === "waiting" || phase === "recovering";
			const shuttingDown = action === "shutdown";
			const progress = {
				shutting: .22,
				waiting: .58,
				recovering: 1,
				off: 1,
				error: .9
			}[phase] ?? 0;
			const ringDash = RING_C * (1 - progress);
			const ringStyle = {
				transform: "rotate(-90deg)",
				transformOrigin: "center"
			};
			if (busy) ringStyle.animation = "dsh-restart-sweep 1.8s linear infinite";
			const captions = shuttingDown ? {
				shutting: t("shutdownClosing"),
				waiting: t("shutdownWaiting"),
				recovering: t("recovering"),
				off: t("off"),
				error: t("shutdownProblem")
			} : {
				shutting: t("restartClosing"),
				waiting: t("restarting"),
				recovering: t("recovering"),
				error: t("restartProblem")
			};
			const subs = shuttingDown ? {
				shutting: t("shutdownSaving"),
				waiting: t("shutdownWaitingSub"),
				recovering: t("recovering"),
				off: t("offHint"),
				error: error ?? t("opFailed")
			} : {
				shutting: t("restartSaving"),
				waiting: t("restartWaiting"),
				recovering: t("restartReady"),
				error: error ?? t("opFailed")
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: dialogRef,
				tabIndex: -1,
				style: VEIL,
				role: "dialog",
				"aria-modal": "true",
				"aria-label": shuttingDown ? t("shutdownDialog") : t("restartDialog"),
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
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: POWER_BTN,
								"aria-hidden": "true",
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
						"aria-live": "polite",
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
							label: t("retry"),
							onClick: () => beginPower(action)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ActionButton, {
							label: t("close"),
							onClick: dismissPower
						})]
					}) : null
				]
			});
		}
		//#endregion
		//#region src/client/RestartPreparing.tsx
		/**
		* Corner "preparing to restart" hint — shown in the brief window between
		* clicking Restart and the connection actually dropping. The page stays fully
		* usable (no full-screen veil): the restart POST is still in flight and the
		* old process is only preparing to exit. Once `beginPower` advances the flow
		* to `shutting`, this hint disappears and the full-screen overlay takes over.
		*/
		/** Corner hint visible only during the 'preparing' phase of a restart. */
		function RestartPreparing() {
			const phase = (0, react.useSyncExternalStore)(onRestartChange, getRestartPhase);
			const action = (0, react.useSyncExternalStore)(onRestartChange, getPowerAction);
			if (phase !== "preparing" || action !== "restart") return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: "status",
				"aria-live": "polite",
				style: {
					position: "fixed",
					bottom: 32,
					left: "50%",
					transform: "translateX(-50%)",
					zIndex: 1700,
					display: "flex",
					alignItems: "center",
					gap: 10,
					padding: "10px 16px",
					borderRadius: 12,
					background: "var(--dsw-alias-toast-bg, rgba(24,28,38,0.95))",
					border: "1px solid var(--dsw-alias-border-l3, rgba(196,211,232,0.25))",
					boxShadow: "0 12px 40px rgba(0, 0, 0, 0.4)",
					color: "var(--dsw-alias-label-primary, #eef2f9)",
					fontFamily: "var(--dsw-font-family, ui-sans-serif, system-ui, sans-serif)",
					fontSize: 13,
					userSelect: "none",
					animation: "dsh-restart-toast-in 0.25s cubic-bezier(0.21, 1.02, 0.45, 1)"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: `
        @keyframes dsh-restart-toast-in {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes dsh-restart-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      ` }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						style: {
							width: 14,
							height: 14,
							borderRadius: "50%",
							border: "2px solid var(--dsw-alias-state-business-tertiary, rgba(65,118,230,0.3))",
							borderTopColor: "var(--dsw-alias-state-business-primary, #4176e6)",
							animation: "dsh-restart-spin 0.9s linear infinite",
							flexShrink: 0
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: tl("restartPreparing") })
				]
			});
		}
		//#endregion
		//#region src/client/ShutdownConfirmDialog.tsx
		/**
		* /shutdown command → GUI confirm dialog.
		*
		* The host `/shutdown` handler never shuts down directly: it signals
		* `SHUTDOWN_CONFIRM_PENDING` through the command/executed event, and this
		* dialog (rendered in shell.overlay) shows the SAME confirmation UI as the
		* power button. Confirm → beginPower('shutdown') POSTs the real shutdown;
		* cancel just dismisses.
		*/
		/** Dialog rendered in shell.overlay while the /shutdown confirm is pending. */
		function ShutdownConfirmDialog() {
			if (!(0, react.useSyncExternalStore)(onShutdownConfirmChange, isShutdownConfirmVisible)) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ShutdownConfirm, {
				title: tl("shutdownConfirmTitle"),
				body: tl("shutdownConfirmBody"),
				confirmLabel: tl("confirmShutdown"),
				cancelLabel: tl("cancel"),
				onConfirm: () => {
					cancelShutdownConfirm();
					beginPower("shutdown");
				},
				onCancel: cancelShutdownConfirm
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Locale dictionaries for dsh-restart-button (zh / en).
		* Registered under the `restart.button` namespace; components receive `t`
		* through the slot's declared `locale:` and follow the DSH UI language.
		*/
		const zh = {
			power: "电源",
			powerTitle: "电源（重启 / 关机）",
			restart: "重启",
			restartHint: "重新启动 DeepSeek Harness",
			shutdown: "关机",
			shutdownHint: "停止 DeepSeek Harness，之后需手动启动",
			shutdownConfirmTitle: "确定要关机吗？",
			shutdownConfirmBody: "关机后 DeepSeek Harness 将停止运行，需要你手动重新启动。",
			confirmShutdown: "关机",
			cancel: "取消",
			restartDialog: "重启 DeepSeek Harness",
			restartClosing: "正在关闭 DeepSeek Harness…",
			restarting: "正在重启…",
			restartPreparing: "正在准备重启…",
			recovering: "正在恢复…",
			restartProblem: "重启出现问题",
			restartSaving: "正在结束进程，即将断开连接",
			restartWaiting: "等待旧进程退出，新实例即将启动",
			restartReady: "新实例已就绪，正在刷新页面",
			shutdownDialog: "关机 DeepSeek Harness",
			shutdownClosing: "正在关机 DeepSeek Harness…",
			shutdownWaiting: "正在关机…",
			shutdownProblem: "关机出现问题",
			shutdownSaving: "正在结束进程，即将断开连接",
			shutdownWaitingSub: "等待进程退出",
			off: "已关机",
			offHint: "可以关闭此页面了；需要时请手动重新启动 DSH",
			opFailed: "操作失败",
			opFailedHttp: "操作失败 (HTTP {0})",
			restartNoEffect: "重启未生效，请重试",
			restartTimeout: "重启超时，请手动刷新",
			shutdownNoEffect: "未检测到 DSH 进程关闭，请手动确认",
			retry: "重试",
			close: "关闭",
			restartedToast: "已重启",
			restartedToastSub: "DeepSeek Harness 已重启完成"
		};
		const en = {
			power: "Power",
			powerTitle: "Power (restart / shutdown)",
			restart: "Restart",
			restartHint: "Restart DeepSeek Harness",
			shutdown: "Shutdown",
			shutdownHint: "Stop DeepSeek Harness; start it manually when needed",
			shutdownConfirmTitle: "Shut down DeepSeek Harness?",
			shutdownConfirmBody: "After shutdown the process stops and you must start it manually.",
			confirmShutdown: "Shut down",
			cancel: "Cancel",
			restartDialog: "Restart DeepSeek Harness",
			restartClosing: "Shutting down DeepSeek Harness…",
			restarting: "Restarting…",
			restartPreparing: "Preparing to restart…",
			recovering: "Recovering…",
			restartProblem: "Restart problem",
			restartSaving: "Ending processes, connection will drop",
			restartWaiting: "Waiting for the old process to exit; a new instance is starting",
			restartReady: "New instance ready, refreshing page",
			shutdownDialog: "Shut down DeepSeek Harness",
			shutdownClosing: "Shutting down DeepSeek Harness…",
			shutdownWaiting: "Shutting down…",
			shutdownProblem: "Shutdown problem",
			shutdownSaving: "Ending processes, connection will drop",
			shutdownWaitingSub: "Waiting for the process to exit",
			off: "Shut down",
			offHint: "You can close this page now; start DSH manually when needed",
			opFailed: "Operation failed",
			opFailedHttp: "Operation failed (HTTP {0})",
			restartNoEffect: "Restart did not take effect, please retry",
			restartTimeout: "Restart timed out, please refresh manually",
			shutdownNoEffect: "Could not confirm DSH shut down; please check manually",
			retry: "Retry",
			close: "Close",
			restartedToast: "Restarted",
			restartedToastSub: "DeepSeek Harness restarted successfully"
		};
		//#endregion
		//#region src/client/index.ts
		/** Required services. */
		const inject = ["slots", "locale"];
		/** Locale namespace for this plugin's UI strings. */
		const NS = "restart.button";
		let phase = "idle";
		let action = "restart";
		let errorMsg = null;
		const listeners = /* @__PURE__ */ new Set();
		/** Locale service captured at apply time; used to translate module-scope
		* (non-component) error strings according to the DSH UI language. */
		let localeSvc;
		/** Translate a key in the current UI language (module scope; components use props.t). */
		function tl(key) {
			return (localeSvc?.snapshot.active === "en" ? en : zh)[key];
		}
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
		/** Monotonic operation id: each beginPower() bumps it; stale timers from a
		* previous operation check it and stop. Prevents an old health poll from
		* overwriting a newer flow's phase (e.g. error → waiting on retry). */
		let operationId = 0;
		/** Kick a restart or shutdown. Opens the overlay and drives the flow.
		* Restart goes through a brief `preparing` stage first (a small corner hint,
		* no full-screen veil) so the user is not slammed by a modal in the first
		* hundreds of milliseconds — the POST is still in flight and the page is
		* alive; the full-screen overlay only appears once the connection is about to
		* actually drop. */
		function beginPower(next) {
			const myOperation = ++operationId;
			const active = () => myOperation === operationId;
			action = next;
			errorMsg = null;
			const endpoint = next === "shutdown" ? "/api/dsh-restart-button/shutdown" : "/api/dsh-restart-button/restart";
			if (next === "restart") {
				phase = "preparing";
				emit();
				setTimeout(() => {
					if (!active() || phase !== "preparing") return;
					phase = "shutting";
					emit();
				}, 800);
			} else {
				phase = "shutting";
				emit();
			}
			if (next === "shutdown") {
				fetch(endpoint, {
					method: "POST",
					keepalive: true
				}).then(async (r) => {
					const j = await r.json().catch(() => ({}));
					if (!active()) return;
					if (!r.ok || j?.ok === false) fail(j?.error ?? tl("opFailedHttp").replace("{0}", String(r.status)));
				}).catch(() => {});
				const SHUTDOWN_POLL_MS = 500;
				const MAX_ATTEMPTS = 4e4 / SHUTDOWN_POLL_MS;
				let attempts = 0;
				let downStreak = 0;
				const timer = setInterval(async () => {
					if (!active()) {
						clearInterval(timer);
						return;
					}
					attempts += 1;
					if (attempts >= MAX_ATTEMPTS) {
						clearInterval(timer);
						phase = "error";
						errorMsg = tl("shutdownNoEffect");
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
						downStreak += 1;
						if (downStreak >= 3) {
							clearInterval(timer);
							phase = "off";
							emit();
						}
					} else downStreak = 0;
				}, SHUTDOWN_POLL_MS);
				return;
			}
			setTimeout(() => {
				if (!active()) return;
				if (phase === "shutting") {
					phase = "waiting";
					emit();
				}
			}, 600);
			(async () => {
				let baseline = null;
				try {
					const r = await fetch("/api/dsh-restart-button/health", { cache: "no-store" });
					if (r.ok) {
						const j = await r.json().catch(() => ({}));
						if (typeof j.instanceId === "string") baseline = j.instanceId;
					}
				} catch {}
				if (!active()) return;
				fetch("/api/dsh-restart-button/restart", {
					method: "POST",
					keepalive: true
				}).then(async (r) => {
					const j = await r.json().catch(() => ({}));
					if (!active()) return;
					if (!r.ok || j?.ok === false) fail(j?.error ?? tl("opFailedHttp").replace("{0}", String(r.status)));
				}).catch(() => {});
				let seenDown = false;
				let upTicks = 0;
				let attempts = 0;
				const POLL_MS = 1e3;
				const MAX_ATTEMPTS = 90;
				const poll = async () => {
					if (!active()) return;
					attempts += 1;
					if (attempts > MAX_ATTEMPTS) {
						phase = "error";
						errorMsg = tl("restartTimeout");
						emit();
						return;
					}
					let up = false;
					let instanceChanged = false;
					try {
						const r = await fetch("/api/dsh-restart-button/health", { cache: "no-store" });
						up = r.ok;
						if (r.ok) {
							const j = await r.json().catch(() => ({}));
							instanceChanged = baseline !== null && typeof j.instanceId === "string" && j.instanceId !== baseline;
						}
					} catch {
						up = false;
					}
					if (!active()) return;
					if (!up) {
						seenDown = true;
						upTicks = 0;
						if (phase !== "waiting") {
							phase = "waiting";
							emit();
						}
					} else {
						if (baseline !== null ? instanceChanged : seenDown && up) {
							phase = "recovering";
							emit();
							setTimeout(() => {
								if (active()) window.location.reload();
							}, 1300);
							return;
						}
						upTicks += 1;
						if (upTicks >= 20) {
							phase = "error";
							errorMsg = tl("restartNoEffect");
							emit();
							return;
						}
					}
					setTimeout(poll, POLL_MS);
				};
				poll();
			})();
		}
		/** Dismiss the error overlay without reloading: cancels any in-flight flow
		* and returns to idle. The restart may have killed the old process without
		* a new one up — reloading here would bounce to a dead page, so just close
		* the dialog and let the user act (refresh manually if they wish). */
		function dismissPower() {
			operationId += 1;
			phase = "idle";
			errorMsg = null;
			emit();
		}
		/** Subscribe to power-flow changes; returns an unsubscribe. */
		function onRestartChange(fn) {
			listeners.add(fn);
			return () => {
				listeners.delete(fn);
			};
		}
		const confirmListeners = /* @__PURE__ */ new Set();
		let confirmVisible = false;
		function emitConfirm() {
			for (const fn of confirmListeners) fn();
		}
		/** Show the shutdown confirm dialog (from the /shutdown command path). */
		function requestShutdownConfirm() {
			confirmVisible = true;
			emitConfirm();
		}
		/** Dismiss the dialog without acting. */
		function cancelShutdownConfirm() {
			confirmVisible = false;
			emitConfirm();
		}
		/** Whether the /shutdown confirm dialog is currently shown. */
		function isShutdownConfirmVisible() {
			return confirmVisible;
		}
		/** Subscribe to dialog visibility changes. */
		function onShutdownConfirmChange(fn) {
			confirmListeners.add(fn);
			return () => {
				confirmListeners.delete(fn);
			};
		}
		/** Sentinel the host `/shutdown` handler returns to request the GUI dialog. */
		const SHUTDOWN_CONFIRM_PENDING = "SHUTDOWN_CONFIRM_PENDING";
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "dsh-restart-button: dictionaries");
			localeSvc = ctx.locale;
			const STYLE_ID = "dsh-restart-button-style";
			let styleEl = document.getElementById(STYLE_ID);
			if (styleEl === null) {
				styleEl = document.createElement("style");
				styleEl.id = STYLE_ID;
				styleEl.textContent = "[class$=\"_footerActions\"]:has(.dsh-restart-button) { flex-wrap: wrap; }";
				document.head.appendChild(styleEl);
			}
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "dsh-restart-button",
				order: -20,
				locale: NS,
				label: (props) => props.t("power")
			}, RestartButton));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-restart-overlay",
				locale: NS
			}, RestartOverlay));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-restart-preparing",
				locale: NS
			}, RestartPreparing));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-restart-notice",
				locale: NS
			}, RestartNotice));
			ctx.effect(() => ctx.on("command/executed", (_sessionId, name, result) => {
				if (name !== "shutdown") return;
				if ((typeof result?.text === "string" ? result.text : "") === SHUTDOWN_CONFIRM_PENDING) requestShutdownConfirm();
			}), "dsh-restart-button: shutdown command confirm");
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-restart-shutdown-confirm",
				locale: NS
			}, ShutdownConfirmDialog));
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.beginPower = beginPower;
		exports.cancelShutdownConfirm = cancelShutdownConfirm;
		exports.dismissPower = dismissPower;
		exports.getPowerAction = getPowerAction;
		exports.getRestartError = getRestartError;
		exports.getRestartPhase = getRestartPhase;
		exports.inject = inject;
		exports.isShutdownConfirmVisible = isShutdownConfirmVisible;
		exports.onRestartChange = onRestartChange;
		exports.onShutdownConfirmChange = onShutdownConfirmChange;
		exports.requestShutdownConfirm = requestShutdownConfirm;
		exports.tl = tl;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map