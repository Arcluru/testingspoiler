// Discord Spoiler Tags Extension for SillyTavern
// Converts ||text|| into clickable spoiler blocks, like Discord.

(function () {
    'use strict';

    // ─── Constants ────────────────────────────────────────────────────────────

    const SPOILER_SOURCE  = '\\|\\|(.+?)\\|\\|';
    const SPOILER_FLAGS   = 'gs';
    const PROCESSED_ATTR  = 'data-ds-done';
    const MAX_RETRIES     = 20;

    // ─── Core: text-node walker ───────────────────────────────────────────────
    //
    // Used for final processing once a message is complete.
    // Walking text nodes avoids double-encoding, cross-tag matching,
    // and nuking revealed-state classes.

    function processMesText(mesText) {
        const textNodes = [];
        const walker = document.createTreeWalker(mesText, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.includes('||')) textNodes.push(node);
        }

        if (textNodes.length === 0) return false;

        textNodes.forEach(textNode => {
            const raw = textNode.nodeValue;
            const fragment = document.createDocumentFragment();
            let lastIndex = 0;
            let match;

            const re = new RegExp(SPOILER_SOURCE, SPOILER_FLAGS);

            while ((match = re.exec(raw)) !== null) {
                if (match.index > lastIndex) {
                    fragment.appendChild(
                        document.createTextNode(raw.slice(lastIndex, match.index))
                    );
                }

                const span = document.createElement('span');
                span.className = 'ds-spoiler';
                span.title = 'Click to reveal spoiler';
                span.setAttribute('aria-label', 'Spoiler — click to reveal');
                span.textContent = match[1];
                span.addEventListener('click', function () {
                    this.classList.toggle('ds-spoiler--revealed');
                });

                fragment.appendChild(span);
                lastIndex = match.index + match[0].length;
            }

            if (lastIndex < raw.length) {
                fragment.appendChild(document.createTextNode(raw.slice(lastIndex)));
            }

            textNode.parentNode.replaceChild(fragment, textNode);
        });

        return true;
    }

    // ─── Per-message processing (final, post-stream) ──────────────────────────

    function processMessage(mes) {
        if (mes.hasAttribute(PROCESSED_ATTR)) return;

        const mesText = mes.querySelector('.mes_text');
        if (!mesText) return;

        if (!mesText.textContent.includes('||')) return;

        const changed = processMesText(mesText);
        if (changed) mes.setAttribute(PROCESSED_ATTR, '1');
    }

    function processAllMessages() {
        document.querySelectorAll('#chat .mes').forEach(processMessage);
    }

    // ─── Streaming: MutationObserver approach ────────────────────────────────
    //
    // The problem with STREAM_TOKEN_RECEIVED + setTimeout:
    //   ST rewrites innerHTML on every token → our spans get nuked → flicker.
    //
    // MutationObserver fires synchronously after the DOM is written but
    // BEFORE the browser paints, so we can hide spoilers in the same frame
    // as ST's update — zero visible gap.
    //
    // During streaming we use a fast innerHTML regex (fine here because
    // we're replacing raw ||text|| that ST just wrote, not stable DOM).
    // The final clean DOM-safe pass runs via processMesText once streaming ends.

    let streamObserver = null;

    function applyStreamingSpoilers(mesText) {
        if (!mesText.innerHTML.includes('||')) return;
        // Disconnect first so our own write doesn't re-trigger the observer
        streamObserver.disconnect();
        mesText.innerHTML = mesText.innerHTML.replace(
            /\|\|(.+?)\|\|/gs,
            '<span class="ds-spoiler" title="Click to reveal spoiler">$1</span>'
        );
        // Reconnect to watch the next token
        streamObserver.observe(mesText, { childList: true, subtree: true, characterData: true });
    }

    function startStreamObserver() {
        stopStreamObserver();

        const messages = document.querySelectorAll('#chat .mes');
        if (!messages.length) return;

        const last = messages[messages.length - 1];
        last.removeAttribute(PROCESSED_ATTR);

        const mesText = last.querySelector('.mes_text');
        if (!mesText) return;

        streamObserver = new MutationObserver(() => {
            applyStreamingSpoilers(mesText);
        });

        streamObserver.observe(mesText, { childList: true, subtree: true, characterData: true });

        // Handle any spoilers already present when streaming starts
        applyStreamingSpoilers(mesText);
    }

    function stopStreamObserver() {
        if (streamObserver) {
            streamObserver.disconnect();
            streamObserver = null;
        }
    }

    // ─── Event registration ───────────────────────────────────────────────────

    let retryCount = 0;

    function registerEvents() {
        const ctx = window.SillyTavern?.getContext?.();

        if (!ctx || !ctx.eventSource || !ctx.event_types) {
            if (++retryCount > MAX_RETRIES) {
                console.warn('[Discord Spoilers] Could not find SillyTavern context after ' +
                             MAX_RETRIES + ' attempts. Giving up.');
                return;
            }
            setTimeout(registerEvents, 500);
            return;
        }

        const { eventSource, event_types } = ctx;

        // Stream finished — stop observer, do the final clean DOM-safe pass
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            stopStreamObserver();
            setTimeout(processAllMessages, 50);
        });

        eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
            setTimeout(processAllMessages, 50);
        });

        // First streaming token — attach observer once, it stays until stream ends
        if (event_types.STREAM_TOKEN_RECEIVED) {
            eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
                if (!streamObserver) startStreamObserver();
            });
        }

        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, () => {
                setTimeout(processAllMessages, 50);
            });
        }

        if (event_types.MESSAGE_EDITED) {
            eventSource.on(event_types.MESSAGE_EDITED, () => {
                document.querySelectorAll(`#chat .mes[${PROCESSED_ATTR}]`).forEach(mes => {
                    mes.removeAttribute(PROCESSED_ATTR);
                });
                setTimeout(processAllMessages, 50);
            });
        }

        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(processAllMessages, 200);
        });

        console.log('[Discord Spoilers] Extension loaded and listening.');
    }

    // ─── Entry point ──────────────────────────────────────────────────────────

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', registerEvents);
    } else {
        registerEvents();
    }

    setTimeout(processAllMessages, 1000);

})();
