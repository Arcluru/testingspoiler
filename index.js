// Discord Spoiler Tags Extension for SillyTavern
// Converts ||text|| into clickable spoiler blocks, like Discord.

(function () {
    'use strict';

    // ─── Constants ────────────────────────────────────────────────────────────

    const SPOILER_SOURCE  = '\\|\\|(.+?)\\|\\|';
    const SPOILER_FLAGS   = 'gs';
    const PROCESSED_ATTR  = 'data-ds-done';   // set on .mes after processing
    const MAX_RETRIES     = 20;               // give up after 10 s (20 × 500 ms)

    // ─── Core: text-node walker ───────────────────────────────────────────────
    //
    // We walk raw TEXT NODES instead of replacing innerHTML. This avoids:
    //   • double HTML-entity encoding (innerHTML already has &amp; etc.)
    //   • regex matching across HTML tag boundaries
    //   • nuking the entire DOM subtree (and any revealed-state classes)

    function processMesText(mesText) {
        // Collect text nodes first — modifying the DOM while walking it is unsafe
        const textNodes = [];
        const walker = document.createTreeWalker(mesText, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeValue.includes('||')) textNodes.push(node);
        }

        if (textNodes.length === 0) return false; // nothing to do

        textNodes.forEach(textNode => {
            const raw = textNode.nodeValue;
            const fragment = document.createDocumentFragment();
            let lastIndex = 0;
            let match;

            // Recreate the regex per call so lastIndex never bleeds between runs
            const re = new RegExp(SPOILER_SOURCE, SPOILER_FLAGS);

            while ((match = re.exec(raw)) !== null) {
                // Text before this match
                if (match.index > lastIndex) {
                    fragment.appendChild(
                        document.createTextNode(raw.slice(lastIndex, match.index))
                    );
                }

                // Build the spoiler span via DOM API.
                // textContent handles all escaping automatically — no manual &amp; needed.
                const span = document.createElement('span');
                span.className = 'ds-spoiler';
                span.title = 'Click to reveal spoiler';
                span.setAttribute('aria-label', 'Spoiler — click to reveal');
                span.textContent = match[1]; // safe: DOM sets text, not HTML
                span.addEventListener('click', function () {
                    this.classList.toggle('ds-spoiler--revealed');
                });

                fragment.appendChild(span);
                lastIndex = match.index + match[0].length;
            }

            // Remaining text after the last match
            if (lastIndex < raw.length) {
                fragment.appendChild(document.createTextNode(raw.slice(lastIndex)));
            }

            textNode.parentNode.replaceChild(fragment, textNode);
        });

        return true;
    }

    // ─── Per-message processing ───────────────────────────────────────────────

    function processMessage(mes) {
        // Skip messages we've already fully processed.
        // This preserves the revealed/hidden state of existing spoilers
        // when new messages arrive later.
        if (mes.hasAttribute(PROCESSED_ATTR)) return;

        const mesText = mes.querySelector('.mes_text');
        if (!mesText) return;

        // Quick bail-out before doing any DOM work
        if (!mesText.textContent.includes('||')) return;

        const changed = processMesText(mesText);

        // Mark done only after a successful pass so streaming messages
        // (which are rebuilt by ST on every token) stay eligible for re-processing
        // until the stream ends and the final render stabilises.
        if (changed) {
            mes.setAttribute(PROCESSED_ATTR, '1');
        }
    }

    // ─── Scan helpers ─────────────────────────────────────────────────────────

    function processAllMessages() {
        document.querySelectorAll('#chat .mes').forEach(processMessage);
    }

    // During streaming ST replaces the last message's innerHTML on every token.
    // Only re-scan the last message in those cases — don't walk the whole history.
    function processLastMessage() {
        const messages = document.querySelectorAll('#chat .mes');
        if (messages.length === 0) return;

        const last = messages[messages.length - 1];
        // Remove the done-marker so the streaming message is always re-evaluated
        last.removeAttribute(PROCESSED_ATTR);
        processMessage(last);
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

        // Fired once when a full character message finishes rendering
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            setTimeout(processAllMessages, 50);
        });

        // Fired once when a user message finishes rendering
        eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
            setTimeout(processAllMessages, 50);
        });

        // Fired repeatedly during streaming — only touch the last message
        if (event_types.STREAM_TOKEN_RECEIVED) {
            eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
                setTimeout(processLastMessage, 50);
            });
        }

        // Fired when a swipe / regeneration updates a message in place
        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, () => {
                setTimeout(processAllMessages, 50);
            });
        }

        // Re-process everything when a different chat is loaded
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

    // Initial sweep for messages already in the DOM on extension load
    setTimeout(processAllMessages, 1000);

})();
