// Keep presentation revisions separate from session/data revisions.
(function () {
  "use strict";
  const script = document.currentScript;
  const expected = script && script.dataset.localizationFingerprint;
  globalThis.CHVLocaleBridge = Object.freeze({
    connect(panel, vscode) {
      const catalog = globalThis.CHVLocalization;
      if (!catalog || catalog.schemaVersion !== 1 || catalog.fingerprint !== expected || !catalog.panels[panel]) {
        vscode.postMessage({ type: "localizationLoadFailed" });
        document.body.replaceChildren();
        return null;
      }
      let revision = -1;
      let language = catalog.defaultLocale;
      let messages = { ...catalog.panels[panel] };
      const supports = value => catalog.locales.includes(value);
      return Object.freeze({
        defaults: catalog.panels[panel],
        runtime: catalog.runtime,
        supports,
        normalize: catalog.normalize,
        captureFocus() {
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || active === document.body) return () => {};
          const parts = [];
          let element = active;
          while (element && element !== document.body) {
            if (element.id) { parts.unshift("#" + CSS.escape(element.id)); break; }
            const position = element.parentElement ? Array.from(element.parentElement.children).indexOf(element) + 1 : 1;
            parts.unshift(element.tagName.toLowerCase() + ":nth-child(" + position + ")");
            element = element.parentElement;
          }
          const start = typeof active.selectionStart === "number" ? active.selectionStart : undefined;
          const end = typeof active.selectionEnd === "number" ? active.selectionEnd : undefined;
          return () => {
            const target = active.isConnected ? active : document.querySelector(parts.join(" > "));
            if (!(target instanceof HTMLElement)) return;
            target.focus({ preventScroll: true });
            if (start !== undefined && end !== undefined && typeof target.setSelectionRange === "function") target.setSelectionRange(start, end);
          };
        },
        receive(value) {
          const message = value && typeof value === "object" ? value : {};
          if (Number.isSafeInteger(message.localeRevision) && message.localeRevision >= revision && supports(message.language)) {
            revision = message.localeRevision;
            language = message.language;
            const incoming = message.i18n && typeof message.i18n === "object" ? message.i18n : {};
            messages = { ...catalog.panels[panel], ...Object.fromEntries(Object.entries(incoming).filter(([key, text]) => Object.hasOwn(catalog.panels[panel], key) && typeof text === "string" && text.length > 0)) };
          }
          document.documentElement.lang = language;
          // Old presentation data never overrides newer text, but its valid session payload survives.
          return { ...message, language, localeRevision: revision, i18n: messages };
        },
      });
    },
  });
})();
