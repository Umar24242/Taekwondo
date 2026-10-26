const defaults = {
	mode: "test",
	sensitivity: -32,
	testColor: "blue",
	testTimer: false,
	testDuration: 60,
	roundDuration: 120,
	timingColor: "blue",
	aiEnabled: true,
	reactionWindow: 2,
};

const settings = loadSettings();
const scores = { blue: 0, red: 0 };
const roundHistory = [];
const ui = {
	blueScore: document.querySelector("#blue-score"),
	redScore: document.querySelector("#red-score"),
	bluePenalties: document.querySelector("#blue-penalties"),
	redPenalties: document.querySelector("#red-penalties"),
	round: document.querySelector("#round"),
	roundTotal: document.querySelector("#round-total"),
	timer: document.querySelector("#timer"),
	timerLabel: document.querySelector("#timer-label"),
	roundLabel: document.querySelector("#round-label"),
	status: document.querySelector("#match-status"),
	aiStatus: document.querySelector("#ai-status"),
	start: document.querySelector("#start-button"),
	sensorStatus: document.querySelector("#sensor-status"),
	sensorStatusText: document.querySelector("#sensor-status-text"),
	sensorButton: document.querySelector("#sensor-button"),
	settingsSensorButton: document.querySelector("#settings-sensor-button"),
	settingsScreen: document.querySelector("#settings-screen"),
	appShell: document.querySelector("#app-shell"),
	beep: document.querySelector("#beep-audio"),
	level: document.querySelector("#level-value"),
};

let matchActive = false;
let matchPaused = false;
let remainingSeconds = 0;
let currentRound = 0;
let roundStartScores = { blue: 0, red: 0 };
let timerInterval;
let cueTimeout;
let windowTimeout;
let aiTimeout;
let transitionTimeout;
let roundTransitionPending = false;
let nextCueAt = 0;
let windowOpenAt = 0;
let windowClosesAt = 0;
let audioContext;
let analyser;
let microphoneStream;
let audioFrame;
let microphoneReady = false;
let pulseStartedAt = 0;
let pulsePeakDb = -Infinity;
let pulseLastLoudAt = 0;
let pulseInvalid = false;
let pulseEligible = false;
let pulseColor = "blue";
let pulseRound = 0;
let ambientFloorDb = -60;
let floorReadyAt = 0;

function loadSettings() {
	try {
		return { ...defaults, ...JSON.parse(localStorage.getItem("taekwondo-sound-settings")) };
	} catch {
		return { ...defaults };
	}
}

function saveSettings() {
	localStorage.setItem("taekwondo-sound-settings", JSON.stringify(settings));
}

function formatTime(seconds) {
	const minutes = Math.floor(seconds / 60);
	return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function setStatus(message, state = "") {
	ui.status.textContent = message;
	ui.status.dataset.state = state;
}

function render() {
	ui.blueScore.value = String(scores.blue);
	ui.redScore.value = String(scores.red);
	ui.bluePenalties.value = "0";
	ui.redPenalties.value = "0";
	ui.round.value = String(currentRound);
	ui.roundTotal.textContent = settings.mode === "timing" ? "/ 3" : "";
	ui.timerLabel.textContent = settings.mode === "timing" ? "WAKTU RONDE" : "TIME OUT";
	ui.roundLabel.textContent = settings.mode === "timing" ? "ROUND" : "MODE TES POIN";
	ui.aiStatus.hidden = settings.mode !== "timing";
	ui.aiStatus.textContent = settings.aiEnabled ? `AI AKTIF · ${settings.timingColor === "blue" ? "MERAH" : "BIRU"}` : "AI NONAKTIF";
	if (matchActive || (settings.mode === "test" && settings.testTimer)) {
		ui.timer.value = formatTime(remainingSeconds);
	} else {
		ui.timer.value = settings.mode === "test" ? "∞" : formatTime(settings.roundDuration);
	}
	ui.start.textContent = matchPaused ? "Lanjut" : matchActive ? "Jeda" : currentRound === 3 && settings.mode === "timing" ? "Ulangi" : "Mulai";
	ui.start.disabled = !microphoneReady || roundTransitionPending;
}

function syncSettingsForm() {
	document.querySelectorAll("[data-mode]").forEach((button) => {
		button.setAttribute("aria-pressed", String(button.dataset.mode === settings.mode));
	});
	document.querySelectorAll("[data-color]").forEach((button) => {
		button.setAttribute("aria-pressed", String(button.dataset.color === selectedColor()));
	});
	document.querySelector("#test-settings").hidden = settings.mode !== "test";
	document.querySelector("#timing-settings").hidden = settings.mode !== "timing";
	document.querySelector("#test-timer-toggle").checked = settings.testTimer;
	document.querySelector("#test-duration-field").hidden = !settings.testTimer;
	document.querySelector("#sensitivity-input").value = settings.sensitivity;
	document.querySelector("#sensitivity-value").textContent = `${settings.sensitivity} dBFS`;
	document.querySelector("#test-duration-input").value = settings.testDuration;
	document.querySelector("#round-duration-input").value = settings.roundDuration;
	document.querySelector("#reaction-window-input").value = settings.reactionWindow;
	document.querySelector("#ai-toggle").checked = settings.aiEnabled;
	ui.settingsSensorButton.textContent = microphoneReady ? "Mikrofon aktif" : "Aktifkan mikrofon";
}

function selectedColor() {
	return settings.mode === "timing" ? settings.timingColor : settings.testColor;
}

function openSettings() {
	if (matchActive && !matchPaused) pauseMatch();
	syncSettingsForm();
	ui.settingsScreen.hidden = false;
	document.body.style.overflow = "auto";
}

function closeSettings() {
	ui.settingsScreen.hidden = true;
	document.body.style.overflow = "hidden";
	render();
}

function addPoint(color, source) {
	scores[color] += 1;
	setStatus(source === "ai" ? `AI +1 · ${color === "blue" ? "Biru" : "Merah"}` : `POIN ${color === "blue" ? "BIRU" : "MERAH"}`, source === "player" ? "point" : "");
	render();
}

function activeWindowAllows(startedAt) {
	if (settings.mode === "test") return matchActive && (!settings.testTimer || remainingSeconds > 0);
	return matchActive && !matchPaused && startedAt >= windowOpenAt && startedAt <= windowClosesAt && windowOpenAt > 0;
}

function finishPulse(endedAt) {
	if (!pulseStartedAt) return;
	const duration = endedAt - pulseStartedAt;
	const peak = pulsePeakDb;
	const wasInvalid = pulseInvalid;
	const wasEligible = pulseEligible;
	const scoreColor = pulseColor;
	const detectedRound = pulseRound;
	pulseStartedAt = 0;
	pulsePeakDb = -Infinity;
	pulseInvalid = false;
	pulseEligible = false;
	if (wasInvalid || duration < 45 || duration > 650 || peak < effectiveThreshold()) return;
	if (wasEligible && matchActive && (settings.mode !== "timing" || detectedRound === currentRound)) addPoint(scoreColor, "player");
}

function effectiveThreshold() {
	return Math.max(settings.sensitivity, ambientFloorDb + 9);
}

function monitorMicrophone() {
	if (!analyser) return;
	const samples = new Float32Array(analyser.fftSize);
	const tick = () => {
		if (!analyser) return;
		analyser.getFloatTimeDomainData(samples);
		let sum = 0;
		for (const sample of samples) sum += sample * sample;
		const rms = Math.sqrt(sum / samples.length);
		const db = rms > 0 ? 20 * Math.log10(rms) : -100;
		const now = performance.now();
		ui.level.textContent = db <= -99 ? "−∞" : `${Math.round(db)}`;
		if (!pulseStartedAt && now > floorReadyAt) {
			ambientFloorDb = ambientFloorDb * .97 + db * .03;
		}
		if (db >= effectiveThreshold()) {
			if (!pulseStartedAt) {
				pulseStartedAt = now;
				pulsePeakDb = db;
				pulseInvalid = false;
				pulseEligible = activeWindowAllows(now);
				pulseColor = selectedColor();
				pulseRound = currentRound;
			} else {
				pulsePeakDb = Math.max(pulsePeakDb, db);
			}
			pulseLastLoudAt = now;
			if (now - pulseStartedAt > 650) pulseInvalid = true;
		} else if (pulseStartedAt && now - pulseLastLoudAt > 180) {
			finishPulse(pulseLastLoudAt);
		}
		audioFrame = requestAnimationFrame(tick);
	};
	if (audioFrame) cancelAnimationFrame(audioFrame);
	floorReadyAt = performance.now() + 1200;
	audioFrame = requestAnimationFrame(tick);
}

async function enableMicrophone() {
	if (microphoneReady) return true;
	if (!navigator.mediaDevices?.getUserMedia) {
		setSensorStatus("Gunakan localhost/HTTPS", "error");
		return false;
	}
	try {
		microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
		audioContext = new (window.AudioContext || window.webkitAudioContext)();
		await audioContext.resume();
		analyser = audioContext.createAnalyser();
		analyser.fftSize = 2048;
		analyser.smoothingTimeConstant = 0;
		audioContext.createMediaStreamSource(microphoneStream).connect(analyser);
		microphoneReady = true;
		ambientFloorDb = -60;
		setSensorStatus("Sensor siap", "ready");
		ui.settingsSensorButton.textContent = "Mikrofon aktif";
		render();
		monitorMicrophone();
		return true;
	} catch (error) {
		setSensorStatus(error.name === "NotAllowedError" ? "Izin mikrofon ditolak" : "Mikrofon tidak tersedia", "error");
		return false;
	}
}

function setSensorStatus(message, state) {
	ui.sensorStatusText.textContent = message;
	ui.sensorStatus.dataset.state = state;
	ui.sensorButton.setAttribute("aria-label", message);
	ui.sensorButton.title = message;
}

function clearMatchTimers() {
	clearInterval(timerInterval);
	clearTimeout(cueTimeout);
	clearTimeout(windowTimeout);
	clearTimeout(aiTimeout);
	clearTimeout(transitionTimeout);
	timerInterval = undefined;
	cueTimeout = undefined;
	windowTimeout = undefined;
	aiTimeout = undefined;
	transitionTimeout = undefined;
	nextCueAt = 0;
	windowOpenAt = 0;
	windowClosesAt = 0;
}

function playCue() {
	if (!matchActive || matchPaused || settings.mode !== "timing") return;
	windowOpenAt = 0;
	windowClosesAt = 0;
	setStatus("BIP · BERSIAP");
	ui.beep.currentTime = 0;
	ui.beep.onended = () => {
		if (!matchActive || matchPaused) return;
		windowOpenAt = performance.now();
		windowClosesAt = windowOpenAt + settings.reactionWindow * 1000;
		setStatus("JENDELA POIN TERBUKA", "window");
		windowTimeout = window.setTimeout(() => {
			windowOpenAt = 0;
			windowClosesAt = 0;
			if (matchActive && !matchPaused) setStatus("Menunggu bip berikutnya");
			if (matchActive && !matchPaused) scheduleCue();
		}, settings.reactionWindow * 1000);
	};
	ui.beep.play().catch(() => setStatus("Gagal memutar bip.mp3", "error"));
}

function scheduleCue() {
	if (!matchActive || matchPaused) return;
	const delay = 3500 + Math.random() * 4500;
	nextCueAt = performance.now() + delay;
	cueTimeout = window.setTimeout(playCue, delay);
}

function scheduleAI() {
	if (!matchActive || matchPaused || settings.mode !== "timing" || !settings.aiEnabled) return;
	const aiColor = settings.timingColor === "blue" ? "red" : "blue";
	const gap = scores[aiColor] - scores[settings.timingColor];
	const interval = gap > 0 ? 14000 + Math.random() * 9000 : gap < 0 ? 8000 + Math.random() * 7000 : 10000 + Math.random() * 9000;
	aiTimeout = window.setTimeout(() => {
		if (!matchActive || matchPaused) return;
		if (Math.random() < .72) addPoint(aiColor, "ai");
		scheduleAI();
	}, interval);
}

function startTimer() {
	clearInterval(timerInterval);
	timerInterval = window.setInterval(() => {
		if (!matchActive || matchPaused) return;
		remainingSeconds = Math.max(0, remainingSeconds - 1);
		render();
		if (remainingSeconds === 0) {
			if (settings.mode === "timing") endRound();
			else stopTest("Waktu tes selesai");
		}
	}, 1000);
}

function startTest() {
	if (matchPaused) {
		matchPaused = false;
		matchActive = true;
		setStatus("Tes dilanjutkan");
		if (settings.testTimer) startTimer();
	} else if (!matchActive) {
		scores.blue = 0;
		scores.red = 0;
		currentRound = 0;
		remainingSeconds = settings.testTimer ? Number(settings.testDuration) : 0;
		matchActive = true;
		matchPaused = false;
		setStatus(settings.testTimer ? "Tes berjalan" : "Tes berjalan · tanpa batas waktu");
		if (settings.testTimer) startTimer();
	} else {
		pauseMatch();
	}
	render();
}

function stopTest(message) {
	matchActive = false;
	matchPaused = false;
	clearMatchTimers();
	setStatus(message);
	render();
}

function startRound() {
	currentRound += 1;
	remainingSeconds = Number(settings.roundDuration);
	roundStartScores = { ...scores };
	matchActive = true;
	matchPaused = false;
	setStatus(`Ronde ${currentRound} dimulai`);
	startTimer();
	scheduleCue();
	scheduleAI();
	render();
}

function endRound() {
	clearMatchTimers();
	matchActive = false;
	matchPaused = false;
	windowOpenAt = 0;
	roundHistory.push({ round: currentRound, blue: scores.blue - roundStartScores.blue, red: scores.red - roundStartScores.red });
	if (currentRound < 3) {
		setStatus(`Ronde ${currentRound} selesai · bersiap ronde berikutnya`);
		roundTransitionPending = true;
		render();
		transitionTimeout = window.setTimeout(() => {
			roundTransitionPending = false;
			if (currentRound < 3 && settings.mode === "timing") startRound();
		}, 1800);
	} else {
		roundTransitionPending = false;
		const playerPoints = scores[settings.timingColor];
		const aiColor = settings.timingColor === "blue" ? "red" : "blue";
		const opponentPoints = scores[aiColor];
		const result = playerPoints === opponentPoints ? "Seri" : playerPoints > opponentPoints ? "Pemain menang" : "AI menang";
		const breakdown = roundHistory.map((round) => `${round.blue}-${round.red}`).join(" / ");
		setStatus(`${result} · ${scores.blue} : ${scores.red} · ${breakdown}`);
		matchActive = false;
		matchPaused = false;
		render();
	}
}

function startTimingMatch() {
	if (matchPaused && currentRound > 0) {
		matchPaused = false;
		matchActive = true;
		setStatus(`Ronde ${currentRound} dilanjutkan`);
		startTimer();
		scheduleCue();
		scheduleAI();
		render();
		return;
	}
	if (matchActive) {
		pauseMatch();
		return;
	}
	if (currentRound === 3) {
		scores.blue = 0;
		scores.red = 0;
		currentRound = 0;
		roundHistory.length = 0;
	}
	if (currentRound === 0) {
		scores.blue = 0;
		scores.red = 0;
		roundHistory.length = 0;
	}
	startRound();
}

function pauseMatch() {
	if (!matchActive) return;
	matchActive = false;
	matchPaused = true;
	clearMatchTimers();
	setStatus("Pertandingan dijeda");
	render();
}

function startOrToggle() {
	if (!microphoneReady) {
		setStatus("Aktifkan sensor mikrofon terlebih dahulu");
		return;
	}
	if (settings.mode === "test") startTest();
	else startTimingMatch();
}

function applySettings() {
	settings.sensitivity = Number(document.querySelector("#sensitivity-input").value);
	settings.testTimer = document.querySelector("#test-timer-toggle").checked;
	settings.testDuration = clampNumber("#test-duration-input", 5, 3600, 60);
	settings.roundDuration = clampNumber("#round-duration-input", 10, 600, 120);
	settings.reactionWindow = clampNumber("#reaction-window-input", .5, 8, 2);
	settings.aiEnabled = document.querySelector("#ai-toggle").checked;
	saveSettings();
	closeSettings();
}

function clampNumber(selector, minimum, maximum, fallback) {
	const input = document.querySelector(selector);
	const value = Number(input.value);
	const safeValue = Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
	input.value = String(safeValue);
	return safeValue;
}

document.querySelector("#settings-button").addEventListener("click", openSettings);
document.querySelector("#back-button").addEventListener("click", closeSettings);
document.querySelector("#apply-button").addEventListener("click", applySettings);
ui.start.addEventListener("click", startOrToggle);

for (const button of document.querySelectorAll("[data-mode]")) {
	button.addEventListener("click", () => {
		if (settings.mode !== button.dataset.mode) {
			clearMatchTimers();
			matchActive = false;
			matchPaused = false;
			roundTransitionPending = false;
			currentRound = 0;
		}
		settings.mode = button.dataset.mode;
		saveSettings();
		syncSettingsForm();
		setStatus("Siap memulai");
		render();
	});
}

for (const button of document.querySelectorAll("[data-color]")) {
	button.addEventListener("click", () => {
		if (settings.mode === "timing") settings.timingColor = button.dataset.color;
		else settings.testColor = button.dataset.color;
		syncSettingsForm();
	});
}

document.querySelector("#sensitivity-input").addEventListener("input", (event) => {
	document.querySelector("#sensitivity-value").textContent = `${event.target.value} dBFS`;
	settings.sensitivity = Number(event.target.value);
	});
document.querySelector("#test-timer-toggle").addEventListener("change", (event) => {
	document.querySelector("#test-duration-field").hidden = !event.target.checked;
	settings.testTimer = event.target.checked;
});

ui.sensorButton.addEventListener("click", enableMicrophone);
ui.settingsSensorButton.addEventListener("click", enableMicrophone);
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && !ui.settingsScreen.hidden) closeSettings();
});

syncSettingsForm();
setSensorStatus("Sensor mati", "off");
render();
