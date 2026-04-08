// Discord Spoiler Tags Extension for SillyTavern
// Converts ||text|| into clickable spoiler blocks, like Discord.

(function () {
    'use strict';

    // ─── Constants ────────────────────────────────────────────────────────────

    const SPOILER_SOURCE  = '\\|\\|(.+?)\\|\\|';
    const SPOILER_FLAGS   = 'gs';
    const PROCESSED_ATTR  = 'data-ds-done';
    const MAX_RETRIES     = 20;

    // ─── Revealed-state registry ──────────────────────────────────────────────
    //
    // SillyTavern fully rewrites mesText.innerHTML on every streaming token,
    // destroying any spans we created the previous tick — including their
    // class lists.  We therefore CANNOT read revealed state from the DOM
    // inside applyStreamingSpoilers; those elements are already gone.
    //
    // Instead we maintain a module-level Set that is written at click time
    // (before ST touches anything) and read each time we recreate the spans.
    // Key = trimmed text content of the spoiler, which is stable for complete
    // ||...|| pairs.
    //
    // LIFECYCLE — this is the critical part:
    //   • Written:  click handler, any time a spoiler is revealed/hidden.
    //   • Read:     applyStreamingSpoilers (during streaming) and
    //               processMessage (final DOM pass after streaming ends).
    //   • Cleared:  at the END of processAllMessages, AFTER the final DOM pass
    //               has already restored revealed state into the live spans.
    //
    // Previously the set was cleared inside stopStreamObserver, which runs
    // ~50 ms BEFORE processAllMessages.  That meant the final DOM pass always
    // saw an empty set and recreated every spoiler in the hidden state, causing
    // revealed spoilers to snap shut the moment streaming finished.

    const revealedSpoilers = new Set();

    // ─── Interaction guard ────────────────────────────────────────────────────
    //
    // In Chromium, if the element under mousedown is removed from the DOM before
    // mouseup fires, the browser cancels the click event entirely.  Because ST
    // replaces innerHTML on every streaming token, the span the user pressed on
    // can be destroyed between mousedown and mouseup, swallowing the click.
    //
    // We set this flag on mousedown (when the target is a spoiler) and clear it
    // on mouseup.  applyStreamingSpoilers skips the innerHTML replacement while
    // the flag is set, keeping the span alive for the full click gesture.

    let userInteracting = false;

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
        if (changed) {
            mes.setAttribute(PROCESSED_ATTR, '1');

            // Restore any spoilers the user revealed during streaming.
            // revealedSpoilers still holds the keys at this point — it is not
            // cleared until the end of processAllMessages, after this runs.
            if (revealedSpoilers.size > 0) {
                mesText.querySelectorAll('.ds-spoiler').forEach(el => {
                    if (revealedSpoilers.has(el.textContent.trim())) {
                        el.classList.add('ds-spoiler--revealed');
                    }
                });
            }
        }
    }

    function processAllMessages() {
        document.querySelectorAll('#chat .mes').forEach(processMessage);
        // Clear only AFTER every processMessage call has had a chance to read
        // the set and restore revealed state into the DOM.
        revealedSpoilers.clear();
    }

    // ─── Streaming: MutationObserver approach ────────────────────────────────

    let streamObserver = null;
    let rafPending     = false;

    function applyStreamingSpoilers(mesText) {
        // Don't destroy the span the user is currently clicking on.
        if (userInteracting) return;

        if (!mesText.innerHTML.includes('||')) return;

        // Disconnect first so our own write doesn't re-trigger the observer.
        streamObserver.disconnect();

        mesText.innerHTML = mesText.innerHTML
            // Pass 1: complete pairs  ||...||
            .replace(
                /\|\|(.+?)\|\|/gs,
                '<span class="ds-spoiler" title="Click to reveal spoiler">$1</span>'
            )
            // Pass 2: unclosed opening || — hides everything after it while
            // the AI is still streaming.
            .replace(
                /\|\|(.+)/gs,
                '<span class="ds-spoiler ds-spoiler--streaming" title="Click to reveal spoiler">$1</span>'
            );

        // Restore revealed state from our persistent registry.
        if (revealedSpoilers.size > 0) {
            mesText.querySelectorAll('.ds-spoiler').forEach(el => {
                if (revealedSpoilers.has(el.textContent.trim())) {
                    el.classList.add('ds-spoiler--revealed');
                }
            });
        }

        // Reconnect to watch the next token.
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
            // Throttle to one innerHTML replacement per animation frame.
            // This eliminates hover flicker and keeps spans stable enough
            // for CSS transitions to render cleanly.
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                applyStreamingSpoilers(mesText);
            });
        });

        streamObserver.observe(mesText, { childList: true, subtree: true, characterData: true });

        // Handle any spoilers already present when streaming starts.
        applyStreamingSpoilers(mesText);
    }

    function stopStreamObserver() {
        if (streamObserver) {
            streamObserver.disconnect();
            streamObserver = null;
        }
        rafPending = false;
        // Do NOT clear revealedSpoilers here.  processAllMessages fires ~50 ms
        // after this and needs the set intact to restore revealed state into the
        // final DOM spans.  The clear happens at the end of processAllMessages.
    }

    // ─── Delegated click handler ──────────────────────────────────────────────

    function attachDelegatedClick() {
        const root = document.getElementById('chat') || document;

        // Set the guard the moment the pointer goes down on a spoiler.
        root.addEventListener('mousedown', function (e) {
            if (e.target.closest('.ds-spoiler')) {
                userInteracting = true;
            }
        });

        // Always clear on mouseup, even if the pointer drifted off the element.
        root.addEventListener('mouseup', function () {
            userInteracting = false;
        });

        // Safety net: if mouseup fires outside #chat, clear the flag there too.
        document.addEventListener('mouseup', function () {
            userInteracting = false;
        });

        root.addEventListener('click', function (e) {
            const spoiler = e.target.closest('.ds-spoiler');
            if (!spoiler) return;

            spoiler.classList.toggle('ds-spoiler--revealed');
            const key = spoiler.textContent.trim();

            if (spoiler.classList.contains('ds-spoiler--revealed')) {
                revealedSpoilers.add(key);
            } else {
                revealedSpoilers.delete(key);
            }
        });
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

        // Stream finished — stop observer, do the final clean DOM-safe pass.
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            stopStreamObserver();
            setTimeout(processAllMessages, 50);
        });

        eventSource.on(event_types.USER_MESSAGE_RENDERED, () => {
            setTimeout(processAllMessages, 50);
        });

        // First streaming token — attach observer once, it stays until stream ends.
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
        document.addEventListener('DOMContentLoaded', () => {
            attachDelegatedClick();
            registerEvents();
        });
    } else {
        attachDelegatedClick();
        registerEvents();
    }

    setTimeout(processAllMessages, 1000);

})();
