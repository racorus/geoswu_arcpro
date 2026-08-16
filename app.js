// Replace this value with the /exec URL from your deployed Apps Script web app.
const API_URL = "https://script.google.com/macros/s/AKfycbx03uUTn5J2jVvLN8iTN1O0EKuXote8tbbATbJsDz_1XBixFoCR8Y94PxXaR5RzZC37/exec";
const AVAILABILITY_REFRESH_MS = 45000;

const state = {
  studentId: "",
  year: "",
  selectedNumber: null,
  taken: new Set(),
  offered: [], // numbers actually offered this term, as reported by the backend
  refreshTimer: null,
  reservationComplete: false
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "statusMessage", "entryStep", "studentForm", "studentId", "continueButton",
    "openCheckButton", "selectionStep", "summaryStudentId", "summaryYear",
    "availabilityCount", "numberGrid", "selectedNumber", "reviewButton",
    "changeStudentButton", "refreshButton", "successStep", "successStudentId",
    "successYear", "successNumber", "confirmDialog", "confirmStudentId",
    "confirmYear", "confirmNumber", "backButton", "confirmButton", "checkDialog",
    "checkForm", "checkStudentId", "checkButton", "checkResult"
  ].forEach((id) => { elements[id] = document.getElementById(id); });

  bindEvents();
});

function bindEvents() {
  elements.studentForm.addEventListener("submit", handleContinue);
  elements.studentId.addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 11);
    hideStatus();
  });
  elements.checkStudentId.addEventListener("input", (event) => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 11);
  });
  elements.numberGrid.addEventListener("click", handleNumberClick);
  elements.reviewButton.addEventListener("click", openConfirmation);
  elements.confirmButton.addEventListener("click", submitReservation);
  elements.changeStudentButton.addEventListener("click", resetToEntry);
  elements.refreshButton.addEventListener("click", () => refreshAvailability(true));
  elements.openCheckButton.addEventListener("click", openCheckDialog);
  elements.checkButton.addEventListener("click", checkExistingReservation);
  elements.checkForm.addEventListener("submit", (event) => event.preventDefault());
  window.addEventListener("beforeunload", stopRefreshTimer);
}

// Rebuilds the grid to show only the numbers the backend actually offers.
// Numbers left out of Code.gs's ALLOWED_NUMBERS_TEXT never appear here.
function buildNumberGrid(numbers) {
  elements.numberGrid.innerHTML = "";
  const fragment = document.createDocumentFragment();
  numbers.forEach((number) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "number-button";
    button.dataset.number = String(number);
    button.textContent = String(number);
    button.setAttribute("aria-label", `Number ${number}, available`);
    fragment.appendChild(button);
  });
  elements.numberGrid.appendChild(fragment);
}

function offeredFromAvailability(data) {
  return [...(data.available || []), ...(data.taken || [])].sort((a, b) => a - b);
}

async function handleContinue(event) {
  event.preventDefault();
  const studentId = elements.studentId.value.trim();
  const validation = validateStudentId(studentId);
  if (!validation.valid) {
    showStatus(validation.message, "error");
    elements.studentId.focus();
    return;
  }

  setButtonLoading(elements.continueButton, true, "Loading…");
  hideStatus();
  try {
    assertConfigured();
    const data = await apiGet("availability", { studentId });
    if (!data.success) throw data;

    if (data.existingReservation) {
      showStatus(
        `You have already selected Number ${data.existingReservation.number} for ${data.existingReservation.year}.`,
        "info"
      );
      return;
    }

    state.studentId = data.studentId;
    state.year = data.year;
    state.selectedNumber = null;
    state.taken = new Set(data.taken || []);
    state.offered = offeredFromAvailability(data);
    buildNumberGrid(state.offered);
    renderSelection();
    showOnly(elements.selectionStep);
    startRefreshTimer();
  } catch (error) {
    showStatus(error.message || "Could not load availability. Please try again.", "error");
  } finally {
    setButtonLoading(elements.continueButton, false);
  }
}

function handleNumberClick(event) {
  const button = event.target.closest(".number-button");
  if (!button || button.disabled) return;
  state.selectedNumber = Number(button.dataset.number);
  renderNumberGrid();
}

function renderSelection() {
  elements.summaryStudentId.textContent = state.studentId;
  elements.summaryYear.textContent = state.year;
  renderNumberGrid();
}

function renderNumberGrid() {
  const buttons = elements.numberGrid.querySelectorAll(".number-button");
  buttons.forEach((button) => {
    const number = Number(button.dataset.number);
    const isTaken = state.taken.has(number);
    const isSelected = state.selectedNumber === number;
    button.disabled = isTaken;
    button.classList.toggle("taken", isTaken);
    button.classList.toggle("selected", isSelected && !isTaken);
    button.setAttribute("aria-pressed", String(isSelected && !isTaken));
    button.setAttribute("aria-label", `Number ${number}, ${isTaken ? "taken" : isSelected ? "selected" : "available"}`);
  });
  elements.availabilityCount.textContent = String(state.offered.length - state.taken.size);
  elements.selectedNumber.textContent = state.selectedNumber === null ? "None" : String(state.selectedNumber);
  elements.reviewButton.disabled = state.selectedNumber === null;
}

function openConfirmation() {
  if (state.selectedNumber === null || state.taken.has(state.selectedNumber)) return;
  elements.confirmStudentId.textContent = state.studentId;
  elements.confirmYear.textContent = state.year;
  elements.confirmNumber.textContent = String(state.selectedNumber);
  elements.confirmDialog.showModal();
}

async function submitReservation() {
  if (state.reservationComplete || state.selectedNumber === null) return;
  setButtonLoading(elements.confirmButton, true, "Confirming…");
  elements.backButton.disabled = true;

  try {
    const data = await apiPost({
      action: "reserve",
      studentId: state.studentId,
      number: state.selectedNumber
    });
    if (!data.success) throw data;

    state.reservationComplete = true;
    stopRefreshTimer();
    elements.confirmDialog.close();
    elements.successStudentId.textContent = data.studentId;
    elements.successYear.textContent = data.year;
    elements.successNumber.textContent = String(data.number);
    showOnly(elements.successStep);
  } catch (error) {
    elements.confirmDialog.close();
    if (error.error === "NUMBER_TAKEN") {
      showStatus(`Sorry, Number ${state.selectedNumber} is no longer available. Please select another number.`, "error");
      state.selectedNumber = null;
      await refreshAvailability(false);
    } else if (error.error === "ALREADY_RESERVED") {
      showStatus(error.message || "You have already selected a number.", "info");
      await refreshAvailability(false);
    } else {
      showStatus(error.message || "The reservation could not be completed. Please try again.", "error");
    }
  } finally {
    setButtonLoading(elements.confirmButton, false);
    elements.backButton.disabled = false;
  }
}

async function refreshAvailability(announce) {
  if (!state.studentId || state.reservationComplete) return;
  elements.refreshButton.disabled = true;
  try {
    const data = await apiGet("availability", { studentId: state.studentId });
    if (!data.success) throw data;
    const newTaken = new Set(data.taken || []);
    const newOffered = offeredFromAvailability(data);
    const offeredChanged = newOffered.length !== state.offered.length
      || newOffered.some((number, index) => number !== state.offered[index]);
    const selectionWasTaken = state.selectedNumber !== null && newTaken.has(state.selectedNumber);
    const selectionNoLongerOffered = state.selectedNumber !== null && !newTaken.has(state.selectedNumber)
      && !new Set(data.available || []).has(state.selectedNumber);
    state.taken = newTaken;
    state.offered = newOffered;
    if (offeredChanged) buildNumberGrid(state.offered);
    if (selectionWasTaken) {
      const lostNumber = state.selectedNumber;
      state.selectedNumber = null;
      showStatus(`Number ${lostNumber} has just been selected by another student. Please choose another number.`, "error");
    } else if (selectionNoLongerOffered) {
      const lostNumber = state.selectedNumber;
      state.selectedNumber = null;
      showStatus(`Number ${lostNumber} is no longer offered. Please choose another number.`, "error");
    } else if (announce) {
      showStatus("Availability is up to date.", "info");
    }
    renderNumberGrid();
  } catch (error) {
    if (announce) showStatus(error.message || "Could not refresh availability.", "error");
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function openCheckDialog() {
  elements.checkStudentId.value = elements.studentId.value;
  elements.checkResult.hidden = true;
  elements.checkResult.className = "check-result";
  elements.checkDialog.showModal();
}

async function checkExistingReservation() {
  const studentId = elements.checkStudentId.value.trim();
  const validation = validateStudentId(studentId);
  if (!validation.valid) {
    showCheckResult(validation.message, false);
    return;
  }

  setButtonLoading(elements.checkButton, true, "Checking…");
  try {
    assertConfigured();
    const data = await apiGet("check", { studentId });
    if (!data.success) throw data;
    if (data.reservation) {
      const item = data.reservation;
      showCheckResult(`Student ID: ${item.studentId}<br>Year: ${item.year}<br>Number: ${item.number}<br>Status: ${item.status}`, true);
    } else {
      showCheckResult("No reservation found.", false);
    }
  } catch (error) {
    showCheckResult(error.message || "Could not check the reservation.", false);
  } finally {
    setButtonLoading(elements.checkButton, false);
  }
}

function validateStudentId(studentId) {
  if (!/^\d{11}$/.test(studentId) || !["68", "67", "66"].includes(studentId.slice(0, 2))) {
    return {
      valid: false,
      message: "Invalid Student ID. Please enter your 11-digit Student ID beginning with 68, 67, or 66."
    };
  }
  return { valid: true };
}

async function apiGet(action, parameters) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({ action, ...parameters }).toString();
  return fetchJson(url.toString(), { method: "GET" });
}

async function apiPost(parameters) {
  return fetchJson(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams(parameters).toString()
  });
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`The server returned ${response.status}.`);
  return response.json();
}

function assertConfigured() {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec(?:\?.*)?$/.test(API_URL)) {
    throw new Error("The Apps Script API URL has not been configured yet.");
  }
}

function showOnly(activeStep) {
  [elements.entryStep, elements.selectionStep, elements.successStep].forEach((step) => {
    step.hidden = step !== activeStep;
  });
  hideStatus();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resetToEntry() {
  stopRefreshTimer();
  state.studentId = "";
  state.year = "";
  state.selectedNumber = null;
  state.taken = new Set();
  state.offered = [];
  elements.numberGrid.innerHTML = "";
  showOnly(elements.entryStep);
  elements.studentId.focus();
}

function startRefreshTimer() {
  stopRefreshTimer();
  state.refreshTimer = window.setInterval(() => refreshAvailability(false), AVAILABILITY_REFRESH_MS);
}

function stopRefreshTimer() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  state.refreshTimer = null;
}

function showStatus(message, type) {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `status-message ${type}`;
  elements.statusMessage.hidden = false;
}

function hideStatus() {
  elements.statusMessage.hidden = true;
}

function showCheckResult(message, success) {
  elements.checkResult.innerHTML = message;
  elements.checkResult.className = `check-result ${success ? "success" : "error"}`;
  elements.checkResult.hidden = false;
}

function setButtonLoading(button, loading, loadingText) {
  if (loading) {
    button.dataset.originalText = button.textContent;
    button.textContent = loadingText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}
