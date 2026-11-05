(() => {
    "use strict";

    const CARD_IMAGES = Object.freeze({
        ambassador: "images/ambassador.png?v=2",
        assassin: "images/assassin.png?v=2",
        captain: "images/captain.png?v=2",
        contessa: "images/contessa.png?v=2",
        duke: "images/duke.png?v=2",
    });
    const CARD_BACK = "images/card_back.png?v=2";
    const STATS_KEY = "coupStats";
    const NAME_KEY = "coupPlayerName";
    const PRODUCTION_API_ORIGIN = "https://coup-api.austxu.dev";
    const CONNECTION_DEADLINE_MS = 75000;
    const socketOrigin = window.location.hostname === "coup.austxu.dev"
        ? PRODUCTION_API_ORIGIN
        : null;
    const isPortfolioEmbed = new URLSearchParams(window.location.search).get("embed") === "portfolio";
    const ACTION_EFFECTS = Object.freeze({
        Income: "+1 coin",
        "Foreign Aid": "+2 coins",
        Coup: "costs 7 coins",
        Tax: "+3 coins",
        Assassinate: "costs 3 coins",
        Steal: "take up to 2 coins",
        Exchange: "draw 2 cards",
    });

    if (isPortfolioEmbed) {
        document.documentElement.classList.add("portfolio-embed");
    }

    const elements = {
        portfolioPreview: document.getElementById("portfolio-preview"),
        portfolioPreviewStart: document.getElementById("portfolio-preview-start"),
        portfolioPreviewStatus: document.getElementById("portfolio-preview-status"),
        lobbyScreen: document.getElementById("lobby-screen"),
        gameScreen: document.getElementById("game-screen"),
        gameOverScreen: document.getElementById("game-over-screen"),
        lobbyForm: document.getElementById("lobby-form"),
        playerName: document.getElementById("player-name"),
        startButton: document.getElementById("start-btn"),
        rematchButton: document.getElementById("rematch-btn"),
        clearScoreButton: document.getElementById("clear-score-btn"),
        lobbyStats: document.getElementById("lobby-stats"),
        topStats: document.getElementById("top-stats"),
        lobbyMessage: document.getElementById("lobby-message"),
        connectionStatus: document.getElementById("connection-status"),
        connectionText: document.getElementById("connection-text"),
        notice: document.getElementById("notice"),
        myName: document.getElementById("my-name"),
        myCoins: document.getElementById("my-coins"),
        myCards: document.getElementById("my-cards"),
        aiName: document.getElementById("ai-name"),
        aiCoins: document.getElementById("ai-coins"),
        aiInfluence: document.getElementById("ai-influence"),
        aiCards: document.getElementById("ai-cards"),
        deckSize: document.getElementById("deck-size"),
        actionFeed: document.getElementById("action-feed"),
        promptContainer: document.getElementById("prompt-container"),
        promptTitle: document.getElementById("prompt-title"),
        promptOptions: document.getElementById("prompt-options"),
        winMessage: document.getElementById("win-message"),
        aiReveal: document.getElementById("ai-reveal"),
        cardModal: document.getElementById("card-modal"),
        modalImage: document.getElementById("modal-img"),
        closeCardModal: document.getElementById("close-card-modal"),
    };

    const state = {
        connected: false,
        aiAvailable: false,
        phase: "lobby",
        gameId: null,
        promptRequestId: null,
        promptSubmitted: false,
        activeView: null,
        interrupted: false,
        countedGameId: null,
        modalPreviousFocus: null,
        pendingStart: false,
        legacyProtocol: false,
    };

    let noticeTimer = null;
    let connectionDeadlineTimer = null;
    let stats = loadStats();

    function readStorage(key) {
        try {
            return window.localStorage.getItem(key);
        } catch (_error) {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            window.localStorage.setItem(key, value);
        } catch (_error) {
            // The game remains usable when storage is disabled or full.
        }
    }

    function loadStats() {
        try {
            const parsed = JSON.parse(readStorage(STATS_KEY) || "null");
            return {
                wins: Number.isInteger(parsed?.wins) && parsed.wins >= 0 ? parsed.wins : 0,
                losses: Number.isInteger(parsed?.losses) && parsed.losses >= 0 ? parsed.losses : 0,
            };
        } catch (_error) {
            return { wins: 0, losses: 0 };
        }
    }

    function updateStatsDisplay() {
        const message = `Wins: ${stats.wins} · Losses: ${stats.losses}`;
        elements.lobbyStats.textContent = message;
        elements.topStats.textContent = message;
    }

    function setScreen(activeScreen) {
        for (const screen of [
            elements.portfolioPreview,
            elements.lobbyScreen,
            elements.gameScreen,
            elements.gameOverScreen,
        ]) {
            const isActive = screen === activeScreen;
            screen.hidden = !isActive;
            screen.classList.toggle("active", isActive);
        }
        document.documentElement.classList.toggle(
            "portfolio-preview-visible",
            activeScreen === elements.portfolioPreview,
        );
        if (!elements.cardModal.hidden) {
            closeCardView(false);
        }
    }

    function setConnectionStatus(kind, message) {
        elements.connectionStatus.dataset.state = kind;
        elements.connectionText.textContent = message;
    }

    function showNotice(message, { error = false, persistent = false } = {}) {
        window.clearTimeout(noticeTimer);
        elements.notice.textContent = message;
        elements.notice.classList.toggle("error", error);
        elements.notice.setAttribute("role", error ? "alert" : "status");
        elements.notice.hidden = false;
        if (!persistent) {
            noticeTimer = window.setTimeout(() => {
                elements.notice.hidden = true;
            }, 5000);
        }
    }

    function clearNotice() {
        window.clearTimeout(noticeTimer);
        noticeTimer = null;
        elements.notice.hidden = true;
        elements.notice.textContent = "";
        elements.notice.classList.remove("error");
        elements.notice.setAttribute("role", "status");
    }

    function updateStartControls() {
        const canStart = !state.pendingStart
            && (state.phase === "lobby" || state.phase === "over")
            && (!state.connected || state.aiAvailable);
        elements.startButton.disabled = !canStart;
        elements.rematchButton.disabled = !canStart;
        elements.portfolioPreviewStart.disabled = !canStart;
        elements.startButton.setAttribute(
            "aria-busy",
            String(state.pendingStart || state.phase === "starting"),
        );
        elements.rematchButton.setAttribute(
            "aria-busy",
            String(state.pendingStart || state.phase === "starting"),
        );
        elements.portfolioPreviewStart.setAttribute(
            "aria-busy",
            String(state.pendingStart || state.phase === "starting"),
        );
        elements.startButton.textContent = state.pendingStart
            ? "Waking server…"
            : state.phase === "starting"
                ? "Starting game…"
                : "Start Game";
        elements.rematchButton.textContent = state.pendingStart
            ? "Waking server…"
            : state.phase === "starting"
                ? "Starting game…"
                : "Play Again";
        elements.portfolioPreviewStart.textContent = state.pendingStart
            ? "Waking server…"
            : state.phase === "starting"
                ? "Starting game…"
                : "Play live bot →";
    }

    function setLobbyMessage(message, isError = false) {
        elements.lobbyMessage.textContent = message;
        elements.lobbyMessage.classList.toggle("error", isError);
        elements.portfolioPreviewStatus.textContent = message
            || "Illustrative position · no live match is running";
        elements.portfolioPreviewStatus.classList.toggle("error", isError);
    }

    function resetBoard() {
        elements.myName.textContent = elements.playerName.value.trim() || "Human";
        elements.myCoins.textContent = "2";
        elements.myCards.replaceChildren();
        elements.aiName.textContent = "PPO-AI";
        elements.aiCoins.textContent = "2";
        elements.aiInfluence.textContent = "2";
        elements.aiCards.replaceChildren();
        elements.actionFeed.replaceChildren();
        elements.deckSize.textContent = "11";
        elements.aiReveal.replaceChildren();
        showWaitingPrompt("Preparing the match…");
    }

    function returnToLobby(message = "", isError = true) {
        state.phase = "lobby";
        state.gameId = null;
        state.promptRequestId = null;
        state.promptSubmitted = false;
        state.activeView = null;
        hidePrompt();
        const returnScreen = isPortfolioEmbed
            ? elements.portfolioPreview
            : elements.lobbyScreen;
        setScreen(returnScreen);
        setLobbyMessage(message, isError && Boolean(message));
        updateStartControls();
        window.requestAnimationFrame(() => {
            (isPortfolioEmbed ? elements.portfolioPreviewStart : elements.playerName).focus();
        });
    }

    function normalisedName() {
        return (elements.playerName.value.trim() || "Human").slice(0, 24);
    }

    function clearConnectionDeadline() {
        window.clearTimeout(connectionDeadlineTimer);
        connectionDeadlineTimer = null;
    }

    function startConnectionDeadline() {
        clearConnectionDeadline();
        connectionDeadlineTimer = window.setTimeout(() => {
            if (!state.pendingStart || state.connected) {
                return;
            }
            state.pendingStart = false;
            socket?.disconnect();
            setConnectionStatus("offline", "Server did not respond");
            setLobbyMessage(
                "The game server did not respond after 75 seconds. Try again to restart the connection.",
                true,
            );
            updateStartControls();
        }, CONNECTION_DEADLINE_MS);
    }

    function requestGameStart() {
        if (!socket) {
            showNotice("The live game client could not be loaded.", { error: true });
            return;
        }
        if (!state.connected) {
            state.pendingStart = true;
            setLobbyMessage(
                "Waking the game server… The first connection can take up to a minute.",
            );
            setConnectionStatus("connecting", "Waking server…");
            updateStartControls();
            startConnectionDeadline();
            socket.connect();
            return;
        }
        if (!state.aiAvailable) {
            showNotice("The AI is not available on this server.", { error: true });
            return;
        }
        if (state.phase === "starting") {
            return;
        }

        const name = normalisedName();
        clearNotice();
        elements.playerName.value = name;
        writeStorage(NAME_KEY, name);
        state.phase = "starting";
        setLobbyMessage("Starting your game…");
        updateStartControls();
        socket.emit("start_game", { player_name: name });
    }

    function cardDetails(cardName) {
        const key = typeof cardName === "string" ? cardName.trim().toLowerCase() : "";
        const displayName = key ? `${key[0].toUpperCase()}${key.slice(1)}` : "Hidden";
        return {
            displayName,
            imageUrl: CARD_IMAGES[key] || CARD_BACK,
        };
    }

    function createCard(
        cardName,
        { revealed = false, hidden = false, label = "card", onSelect = null } = {},
    ) {
        if (hidden) {
            const card = document.createElement("div");
            card.className = "card hidden-card";
            card.setAttribute("role", "img");
            card.setAttribute("aria-label", label);
            return card;
        }

        const details = cardDetails(cardName);
        const card = document.createElement("button");
        card.type = "button";
        card.className = "card";
        card.setAttribute("aria-label", label);
        if (revealed) {
            card.classList.add("revealed");
        }
        if (onSelect) {
            card.classList.add("selectable");
            card.addEventListener("click", () => onSelect(card));
        } else {
            card.addEventListener("click", () => {
                openCardView(details.imageUrl, details.displayName, card);
            });
        }

        const image = document.createElement("img");
        image.src = details.imageUrl;
        image.alt = "";
        image.draggable = false;
        image.addEventListener(
            "error",
            () => {
                image.src = CARD_BACK;
            },
            { once: true },
        );
        card.appendChild(image);
        return card;
    }

    function openCardView(imageUrl, cardName, trigger) {
        state.modalPreviousFocus = trigger || document.activeElement;
        setBackgroundInert(true);
        elements.modalImage.src = imageUrl;
        elements.modalImage.alt = `${cardName} card`;
        elements.cardModal.hidden = false;
        elements.closeCardModal.focus();
    }

    function closeCardView(restoreFocus = true) {
        elements.cardModal.hidden = true;
        elements.modalImage.alt = "";
        setBackgroundInert(false);
        if (restoreFocus && state.modalPreviousFocus?.isConnected) {
            state.modalPreviousFocus.focus();
        }
        state.modalPreviousFocus = null;
    }

    function setBackgroundInert(isInert) {
        for (const element of [
            elements.connectionStatus,
            elements.lobbyScreen,
            elements.gameScreen,
            elements.gameOverScreen,
            elements.notice,
            document.getElementById("top-score-box"),
        ]) {
            element.inert = isInert;
        }
    }

    function playerNameFor(playerIndex, view) {
        if (playerIndex === view?.player_id) {
            return view.name || "You";
        }
        const opponent = arrayValue(view?.opponents).find(
            (candidate) => candidate?.player_id === playerIndex,
        );
        return opponent?.name || `Player ${Number(playerIndex) + 1}`;
    }

    function arrayValue(value) {
        return Array.isArray(value) ? value : [];
    }

    function renderView(view) {
        if (!view || typeof view !== "object") {
            showNotice("The server sent an invalid game state.", { error: true });
            return;
        }

        elements.myName.textContent = view.name || "You";
        elements.myCoins.textContent = String(view.my_coins ?? 0);
        elements.myCards.replaceChildren();
        for (const cardName of arrayValue(view.my_cards)) {
            const details = cardDetails(cardName);
            elements.myCards.appendChild(
                createCard(cardName, { label: `View your ${details.displayName} card` }),
            );
        }
        for (const cardName of arrayValue(view.my_revealed)) {
            const details = cardDetails(cardName);
            elements.myCards.appendChild(
                createCard(cardName, {
                    revealed: true,
                    label: `View your revealed ${details.displayName} card`,
                }),
            );
        }

        const opponent = arrayValue(view.opponents)[0];
        if (opponent) {
            elements.aiName.textContent = opponent.name || "Opponent";
            elements.aiCoins.textContent = String(opponent.coins ?? 0);
            elements.aiInfluence.textContent = String(opponent.influence_count ?? 0);
            elements.aiCards.replaceChildren();
            for (let index = 0; index < Number(opponent.influence_count || 0); index += 1) {
                elements.aiCards.appendChild(
                    createCard(null, { hidden: true, label: "Hidden opponent card" }),
                );
            }
            for (const cardName of arrayValue(opponent.revealed)) {
                const details = cardDetails(cardName);
                elements.aiCards.appendChild(
                    createCard(cardName, {
                        revealed: true,
                        label: `View opponent's revealed ${details.displayName} card`,
                    }),
                );
            }
        }

        elements.deckSize.textContent = String(view.court_deck_size ?? 0);
        renderActionFeed(view);
    }

    function renderActionFeed(view) {
        const history = arrayValue(view.action_history);
        if (history.length === 0) {
            if (!elements.actionFeed.querySelector(".feed-empty")) {
                const empty = document.createElement("p");
                empty.className = "feed-empty";
                empty.textContent = "No actions yet.";
                elements.actionFeed.replaceChildren(empty);
            }
            return;
        }

        elements.actionFeed.querySelector(".feed-empty")?.remove();
        const existingEntries = [...elements.actionFeed.querySelectorAll(".feed-item")];
        for (const staleEntry of existingEntries.slice(history.length)) {
            staleEntry.remove();
        }

        const newEntries = document.createDocumentFragment();
        for (const [index, item] of history.entries()) {
            const actor = playerNameFor(item.player, view);
            const target = item.target == null ? null : playerNameFor(item.target, view);
            let message = `${actor} used ${item.action || "an action"}`;
            if (target) {
                message += ` on ${target}`;
            }
            if (item.was_blocked) {
                message += " — blocked";
            }
            if (item.was_challenged) {
                message += item.challenge_won
                    ? " — challenge succeeded"
                    : " — challenge failed";
            }
            if (item.blocker != null && item.blocking_card) {
                const blocker = playerNameFor(item.blocker, view);
                message += ` — ${blocker} claimed ${item.blocking_card} to block`;
                if (item.counter_was_challenged) {
                    message += item.counter_challenge_won
                        ? " (block challenge succeeded)"
                        : " (block challenge failed)";
                }
            }

            const existingEntry = existingEntries[index];
            if (existingEntry) {
                if (existingEntry.textContent !== message) {
                    existingEntry.textContent = message;
                }
            } else {
                const entry = document.createElement("p");
                entry.className = "feed-item";
                entry.textContent = message;
                newEntries.appendChild(entry);
            }
        }
        elements.actionFeed.appendChild(newEntries);
        elements.actionFeed.scrollTop = elements.actionFeed.scrollHeight;
    }

    function showPrompt(title, content) {
        elements.promptTitle.textContent = title;
        elements.promptOptions.replaceChildren(content);
        elements.promptContainer.classList.remove("prompt-hidden");
        elements.promptContainer.classList.add("prompt-active");
        elements.promptContainer.setAttribute("aria-busy", "false");
        state.promptSubmitted = false;

        window.requestAnimationFrame(() => {
            const firstControl = elements.promptOptions.querySelector("button:not(:disabled)");
            (firstControl || elements.promptTitle).focus();
        });
    }

    function showWaitingPrompt(message) {
        const waiting = document.createElement("p");
        waiting.className = "waiting-message";
        waiting.textContent = "The AI is thinking.";
        showPrompt(message, waiting);
        elements.promptContainer.setAttribute("aria-busy", "true");
    }

    function hidePrompt() {
        elements.promptContainer.classList.remove("prompt-active");
        elements.promptContainer.classList.add("prompt-hidden");
        elements.promptContainer.setAttribute("aria-busy", "false");
        elements.promptOptions.replaceChildren();
    }

    function actionButton(label, response, { danger = false } = {}) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn action-btn";
        if (danger) {
            button.classList.add("danger-btn");
        }
        button.textContent = label;
        button.addEventListener("click", () => submitPrompt(response));
        return button;
    }

    function optionGroup(...children) {
        const fragment = document.createDocumentFragment();
        for (const child of children) {
            fragment.appendChild(child);
        }
        return fragment;
    }

    function submitPrompt(response) {
        if (
            !socket
            || !state.connected
            || !state.gameId
            || (!state.legacyProtocol && !Number.isInteger(state.promptRequestId))
            || state.promptSubmitted
        ) {
            return;
        }

        state.promptSubmitted = true;
        for (const button of elements.promptOptions.querySelectorAll("button")) {
            button.disabled = true;
        }
        elements.promptContainer.setAttribute("aria-busy", "true");
        const waiting = document.createElement("p");
        waiting.className = "choice-status";
        waiting.textContent = "Choice submitted. Waiting for the next turn…";
        elements.promptOptions.appendChild(waiting);
        socket.emit(
            "player_action",
            state.legacyProtocol
                ? response
                : {
                    ...response,
                    game_id: state.gameId,
                    request_id: state.promptRequestId,
                },
        );
    }

    const promptHandlers = {
        choose_action(payload) {
            const controls = document.createDocumentFragment();
            for (const [index, action] of arrayValue(payload.legal_actions).entries()) {
                let label = action.action_type || "Action";
                if (ACTION_EFFECTS[action.action_type]) {
                    label += ` · ${ACTION_EFFECTS[action.action_type]}`;
                }
                if (action.target_idx != null) {
                    label += ` → ${playerNameFor(action.target_idx, payload.view)}`;
                }
                controls.appendChild(actionButton(label, { choice_index: index }));
            }
            showPrompt("Choose an action", controls);
        },

        choose_challenge(payload) {
            const claimer = playerNameFor(payload.claimer_idx, payload.view);
            showPrompt(
                `Challenge ${claimer}'s ${payload.claimed_card} claim?`,
                optionGroup(
                    actionButton("Challenge", { challenge: true }, { danger: true }),
                    actionButton("Allow claim", { challenge: false }),
                ),
            );
        },

        choose_counteraction(payload) {
            const actor = playerNameFor(payload.actor_idx, payload.view);
            const controls = document.createDocumentFragment();
            controls.appendChild(actionButton("Pass", { choice_index: -1 }));
            for (const [index, card] of arrayValue(payload.blocking_cards).entries()) {
                controls.appendChild(
                    actionButton(`Block with ${card}`, { choice_index: index }),
                );
            }
            showPrompt(`Block ${actor}'s ${payload.action_type}?`, controls);
        },

        choose_challenge_counter(payload) {
            const blocker = playerNameFor(payload.blocker_idx, payload.view);
            showPrompt(
                `Challenge ${blocker}'s ${payload.blocking_card} block?`,
                optionGroup(
                    actionButton("Challenge block", { challenge: true }, { danger: true }),
                    actionButton("Allow block", { challenge: false }),
                ),
            );
        },

        choose_card_to_lose(payload) {
            const controls = document.createDocumentFragment();
            for (const [index, card] of arrayValue(payload.view?.my_cards).entries()) {
                controls.appendChild(
                    actionButton(`Reveal ${card}`, { choice_index: index }, { danger: true }),
                );
            }
            showPrompt("Choose an influence to reveal", controls);
        },

        choose_exchange_cards(payload) {
            const wrapper = document.createElement("div");
            wrapper.className = "exchange-options";
            const grid = document.createElement("div");
            grid.className = "exchange-grid";
            const selection = new Set();
            const keepCount = Number(payload.num_to_keep);

            const confirmButton = document.createElement("button");
            confirmButton.type = "button";
            confirmButton.className = "btn primary-btn";
            confirmButton.textContent = "Confirm cards";
            confirmButton.disabled = true;

            for (const [index, cardName] of arrayValue(payload.all_cards).entries()) {
                const details = cardDetails(cardName);
                const card = createCard(cardName, {
                    label: `Keep ${details.displayName}`,
                    onSelect(cardElement) {
                        if (selection.has(index)) {
                            selection.delete(index);
                            cardElement.classList.remove("is-selected");
                            cardElement.setAttribute("aria-pressed", "false");
                        } else if (selection.size < keepCount) {
                            selection.add(index);
                            cardElement.classList.add("is-selected");
                            cardElement.setAttribute("aria-pressed", "true");
                        }
                        confirmButton.disabled = selection.size !== keepCount;
                    },
                });
                card.setAttribute("aria-pressed", "false");
                grid.appendChild(card);
            }

            confirmButton.addEventListener("click", () => {
                submitPrompt({ choice_indices: [...selection].sort((a, b) => a - b) });
            });
            wrapper.append(grid, confirmButton);
            showPrompt(`Keep ${keepCount} card${keepCount === 1 ? "" : "s"}`, wrapper);
        },
    };

    const savedName = readStorage(NAME_KEY);
    if (savedName) {
        elements.playerName.value = savedName.slice(0, 24);
    }
    updateStatsDisplay();
    updateStartControls();
    if (isPortfolioEmbed) {
        setScreen(elements.portfolioPreview);
    }

    elements.lobbyForm.addEventListener("submit", (event) => {
        event.preventDefault();
        requestGameStart();
    });
    elements.portfolioPreviewStart.addEventListener("click", requestGameStart);
    elements.rematchButton.addEventListener("click", requestGameStart);
    elements.clearScoreButton.addEventListener("click", () => {
        stats = { wins: 0, losses: 0 };
        writeStorage(STATS_KEY, JSON.stringify(stats));
        updateStatsDisplay();
        showNotice("Match record cleared.");
    });
    elements.closeCardModal.addEventListener("click", () => closeCardView());
    elements.cardModal.addEventListener("click", (event) => {
        if (event.target === elements.cardModal) {
            closeCardView();
        }
    });
    document.addEventListener("keydown", (event) => {
        if (!elements.cardModal.hidden) {
            if (event.key === "Escape") {
                closeCardView();
            } else if (event.key === "Tab") {
                event.preventDefault();
                elements.closeCardModal.focus();
            }
        }
    });

    const socketOptions = {
        autoConnect: false,
        reconnection: true,
        reconnectionAttempts: 8,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
    };
    const socket = typeof window.io === "function"
        ? socketOrigin
            ? window.io(socketOrigin, socketOptions)
            : window.io(socketOptions)
        : null;

    if (!socket) {
        setConnectionStatus("offline", "Client unavailable");
        setLobbyMessage(
            "The live game client could not be loaded. Check your connection and refresh.",
            true,
        );
        elements.portfolioPreviewStart.disabled = true;
        showNotice("Could not load the live game client.", { error: true, persistent: true });
        return;
    }

    socket.on("connect", () => {
        clearConnectionDeadline();
        state.connected = true;
        const shouldStart = state.pendingStart;
        state.pendingStart = false;
        // The production service predates the `server_ready` event. A successful dedicated
        // Socket.IO connection is its readiness signal; newer same-origin servers still
        // confirm model availability explicitly below.
        if (socketOrigin) {
            state.aiAvailable = true;
        }
        setConnectionStatus("online", socketOrigin ? "Connected" : "Connected · checking");
        clearNotice();
        if (state.interrupted) {
            state.interrupted = false;
            returnToLobby("Connection restored. Start a new match to continue.", false);
            return;
        }
        updateStartControls();
        if (shouldStart && state.aiAvailable) {
            requestGameStart();
        }
    });

    socket.on("server_ready", (data) => {
        state.legacyProtocol = false;
        state.aiAvailable = Boolean(data?.ai_available);
        const shouldStart = state.pendingStart;
        state.pendingStart = false;
        clearConnectionDeadline();
        setLobbyMessage(
            state.aiAvailable ? "" : "The AI model is currently unavailable.",
            !state.aiAvailable,
        );
        updateStartControls();
        if (shouldStart && state.aiAvailable) {
            requestGameStart();
        }
    });

    socket.on("disconnect", () => {
        clearConnectionDeadline();
        state.connected = false;
        setConnectionStatus("offline", "Reconnecting…");
        if (state.phase === "starting" || state.phase === "playing") {
            state.interrupted = true;
            state.promptSubmitted = true;
            for (const button of elements.promptOptions.querySelectorAll("button")) {
                button.disabled = true;
            }
            showNotice("Connection lost. This match has ended.", {
                error: true,
                persistent: true,
            });
        }
        updateStartControls();
    });

    socket.on("connect_error", () => {
        state.connected = false;
        if (state.pendingStart) {
            setConnectionStatus("connecting", "Still waking server…");
            setLobbyMessage(
                "Still waking the game server… This can take up to a minute on the first connection.",
            );
        } else {
            setConnectionStatus("offline", "Unable to connect");
            setLobbyMessage("The game server is unavailable. Try connecting again.", true);
        }
        updateStartControls();
    });

    setConnectionStatus("idle", "Start a game to connect");
    updateStartControls();

    socket.on("game_starting", (data) => {
        if (!data?.game_id) {
            return;
        }
        clearNotice();
        state.gameId = data.game_id;
        state.phase = "starting";
        state.promptRequestId = null;
        state.promptSubmitted = false;
        if (data.player_name) {
            elements.playerName.value = data.player_name;
        }
        resetBoard();
        setScreen(elements.gameScreen);
        updateStartControls();
    });

    socket.on("game_started", (data) => {
        const legacyPayload = !data?.game_id;
        if (!legacyPayload && data.game_id !== state.gameId) {
            return;
        }
        if (legacyPayload) {
            state.legacyProtocol = true;
            state.gameId = `legacy-${Date.now()}`;
            state.promptRequestId = null;
            state.promptSubmitted = false;
            resetBoard();
            setScreen(elements.gameScreen);
        }
        state.phase = "playing";
        if (data.player_name) {
            elements.myName.textContent = data.player_name;
        }
        updateStartControls();
    });

    socket.on("game_prompt", (payload) => {
        const legacyPayload = state.legacyProtocol
            && payload?.game_id == null
            && payload?.request_id == null;
        if (state.phase !== "playing") {
            return;
        }
        if (
            !legacyPayload
            && (
                payload?.game_id !== state.gameId
                || !Number.isInteger(payload?.request_id)
            )
        ) {
            return;
        }
        state.activeView = payload.view;
        state.promptRequestId = legacyPayload ? 0 : payload.request_id;
        state.promptSubmitted = false;
        renderView(payload.view);
        const handler = promptHandlers[payload.type];
        if (handler) {
            handler(payload);
        } else {
            showNotice("The server requested an unsupported choice.", { error: true });
        }
    });

    socket.on("game_over", (data) => {
        const legacyPayload = state.legacyProtocol && data?.game_id == null;
        if (!legacyPayload && data?.game_id !== state.gameId) {
            return;
        }
        if (data.final_view) {
            renderView(data.final_view);
        }
        hidePrompt();
        state.phase = "over";
        state.promptRequestId = null;
        state.promptSubmitted = false;

        const result = data.result
            || (data.winner === "Draw"
                ? "draw"
                : data.winner === normalisedName()
                    ? "win"
                    : "loss");
        const completedGameId = data.game_id || state.gameId;
        if (state.countedGameId !== completedGameId) {
            if (result === "win") {
                stats.wins += 1;
            } else if (result === "loss") {
                stats.losses += 1;
            }
            state.countedGameId = completedGameId;
            writeStorage(STATS_KEY, JSON.stringify(stats));
            updateStatsDisplay();
        }

        if (result === "win") {
            elements.winMessage.textContent = "You win!";
        } else if (result === "loss") {
            elements.winMessage.textContent = `${data.winner || "PPO-AI"} wins`;
        } else {
            elements.winMessage.textContent = "It's a draw";
        }

        elements.aiReveal.replaceChildren();
        for (const cardName of arrayValue(data.ai_final_cards)) {
            const details = cardDetails(cardName);
            elements.aiReveal.appendChild(
                createCard(cardName, { label: `View AI's final ${details.displayName} card` }),
            );
        }
        setScreen(elements.gameOverScreen);
        elements.winMessage.setAttribute("tabindex", "-1");
        elements.winMessage.focus();
        updateStartControls();
    });

    socket.on("game_error", (data) => {
        const message = data?.error || "The game could not continue.";
        if (data?.code === "game_in_progress" && data?.game_id === state.gameId) {
            showNotice(message, { error: true });
            updateStartControls();
            return;
        }
        if (data?.game_id && state.gameId && data.game_id !== state.gameId) {
            return;
        }
        returnToLobby(message);
        showNotice(message, { error: true });
    });

    socket.on("action_rejected", (data) => {
        if (data?.game_id && data.game_id !== state.gameId) {
            return;
        }
        showNotice(data?.error || "That choice is no longer active.", { error: true });
    });
})();
