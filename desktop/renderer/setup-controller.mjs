import { readExcludes } from "./input-values.mjs";
import { isValidSSHHost, MAX_HOST_LENGTH } from "../common/ssh-host.mjs";

// Wizard owns only its steps, per-machine draft roots, and submission state.
export function createSetupController({
  document,
  api,
  defaults,
  onSubmit,
  onThemeChange,
}) {
  const $ = (selector) => document.querySelector(selector);
  $("#setup-host").maxLength = MAX_HOST_LENGTH;
  let setupStep = 1,
    setupInitialized = false,
    setupSubmitting = false;
  let context = {
    required: false,
    root: "",
    resetting: false,
    theme: "system",
    excludes: [...defaults.excludes],
  };
  function setupOptions() {
    return {
      root: $("#setup-root").value.trim(),
      host: $("#setup-remote").checked ? $("#setup-host").value.trim() : "",
      github: $("#setup-github").checked,
      fetch: $("#setup-fetch").checked,
      excludes: readExcludes($("#setup-excludes")),
    };
  }
  function renderSetupStep(focus = true) {
    const titles = [
      "Choose your workspace",
      "Set your scan preferences",
      "Ready to scan",
    ];
    const descriptions = [
      "Start with the machine and folder where you keep your Git projects.",
      "Choose how much to check. These settings are saved for future scans.",
      "Review your choices. You can change them later in Settings.",
    ];
    $("#setup-title").textContent = titles[setupStep - 1];
    $("#setup-description").textContent = descriptions[setupStep - 1];
    $("#setup-step-label").textContent = `${setupStep} of 3`;
    $("#setup-dialog").dataset.step = String(setupStep);
    [1, 2, 3].forEach((step) => {
      $(`#setup-step-${step}`).hidden = step !== setupStep;
    });
    $("#setup-back").hidden = setupStep === 1;
    $("#setup-next").hidden = setupStep === 3;
    $("#setup-start").hidden = setupStep !== 3;
    $("#setup-error").hidden = true;
    if (setupStep === 3) {
      const options = setupOptions();
      $("#setup-review-machine").textContent = options.host || "This computer";
      $("#setup-review-root").textContent = options.root;
      $("#setup-review-github").textContent = options.github
        ? "On · network requests"
        : "Off · local Git data";
      $("#setup-review-fetch").textContent = options.fetch
        ? "On · fetch each repository"
        : "Off · cached references";
      $("#setup-review-excludes").textContent = options.excludes.length
        ? `${options.excludes.length} entries`
        : "None · scan all directories";
      $("#setup-review-excludes").title = options.excludes.join("\n");
      $("#setup-review-theme").textContent =
        $("#setup-theme").selectedOptions[0].textContent;
    }
    if (focus) {
      $("#setup-dialog").scrollTop = 0;
      $("#setup-title").focus({ preventScroll: true });
    }
  }
  function openSetup() {
    if (!context.required) return;
    document.querySelectorAll("dialog[open]").forEach((dialog) => {
      if (dialog.id !== "setup-dialog") dialog.close();
    });
    if (!setupInitialized) {
      setupInitialized = true;
      $("#setup-root").value = context.root || "~";
      $("#setup-theme").value = context.theme;
      $("#setup-excludes").value = context.excludes.join("\n");
      $("#setup-github").checked = false;
      $("#setup-fetch").checked = false;
      renderSetupStep(false);
    }
    if (!$("#setup-dialog").open) {
      $("#setup-dialog").showModal();
      $("#setup-local").focus();
    }
  }
  function validateSetupLocation() {
    if (!$("#setup-root").value.trim()) {
      $("#setup-root").focus();
      $("#setup-root").reportValidity();
      return false;
    }
    if (
      $("#setup-remote").checked &&
      !isValidSSHHost($("#setup-host").value.trim())
    ) {
      $("#setup-error").textContent =
        `Enter an SSH alias or user@hostname, up to ${MAX_HOST_LENGTH} characters, without spaces or command options.`;
      $("#setup-error").hidden = false;
      $("#setup-host").focus();
      return false;
    }
    return true;
  }
  $("#setup-dialog").addEventListener("cancel", (event) =>
    event.preventDefault(),
  );
  $("#setup-dialog").addEventListener("close", () => {
    if (context.required && !setupSubmitting && !context.resetting) openSetup();
  });
  let setupMachine = "local",
    setupRoots = { local: "", remote: "~" };
  function changeSetupMachine() {
    setupRoots[setupMachine] = $("#setup-root").value;
    setupMachine = $("#setup-remote").checked ? "remote" : "local";
    $("#setup-root").value = setupRoots[setupMachine] || context.root || "~";
    $("#setup-host-field").hidden = setupMachine !== "remote";
    $("#setup-choose-folder").hidden = setupMachine === "remote";
    if (setupMachine === "remote") $("#setup-host").focus();
  }
  $("#setup-local").onchange = changeSetupMachine;
  $("#setup-remote").onchange = changeSetupMachine;
  $("#setup-choose-folder").onclick = async () => {
    try {
      const root = await api.chooseFolder();
      if (root) $("#setup-root").value = root;
    } catch (error) {
      $("#setup-error").textContent = error.message;
      $("#setup-error").hidden = false;
    }
  };
  $("#setup-next").onclick = () => {
    if (setupSubmitting || (setupStep === 1 && !validateSetupLocation()))
      return;
    if (setupStep < 3) {
      setupStep++;
      renderSetupStep();
    }
  };
  $("#setup-back").onclick = () => {
    if (!setupSubmitting && setupStep > 1) {
      setupStep--;
      renderSetupStep();
    }
  };
  $("#setup-theme").onchange = () => {
    onThemeChange($("#setup-theme").value);
  };
  $("#setup-form").onsubmit = async (event) => {
    event.preventDefault();
    if (setupStep < 3) {
      $("#setup-next").click();
      return;
    }
    if (setupSubmitting || !validateSetupLocation()) return;
    setupSubmitting = true;
    $("#setup-start").disabled = true;
    $("#setup-back").disabled = true;
    $("#setup-start").textContent = "Starting…";
    $("#setup-error").hidden = true;
    const options = setupOptions();
    const theme = $("#setup-theme").value;
    onThemeChange(theme);
    try {
      await onSubmit({ ...options, theme });
      $("#setup-dialog").close();
    } catch (error) {
      $("#setup-error").textContent = error.message;
      $("#setup-error").hidden = false;
    } finally {
      setupSubmitting = false;
      $("#setup-start").disabled = false;
      $("#setup-back").disabled = false;
      $("#setup-start").textContent = "Start scanning";
    }
  };

  $("#setup-reset-excludes").onclick = () => {
    $("#setup-excludes").value = defaults.excludes.join("\n");
  };
  function reset() {
    setupStep = 1;
    setupInitialized = false;
    setupSubmitting = false;
    setupMachine = "local";
    setupRoots = { local: "", remote: "~" };
    $("#setup-form").reset();
    $("#setup-dialog").scrollTop = 0;
    $("#setup-host-field").hidden = true;
    $("#setup-choose-folder").hidden = false;
    $("#setup-start").disabled = false;
    $("#setup-back").disabled = false;
    $("#setup-start").textContent = "Start scanning";
  }
  return {
    open: openSetup,
    reset,
    setContext(next) {
      context = next;
    },
  };
}
