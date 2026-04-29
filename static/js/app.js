async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    throw new Error("Request failed");
  }
  return res.json();
}

let currentSprint = null;
let peopleCache = [];
let projectsCache = [];
let storiesCache = [];
let isDirty = false;
let isSaved = false;
let isViewOnly = false;
let isClosureView = false;

async function loadPeople() {
  peopleCache = await fetchJson("/api/people/list");
  return peopleCache;
}

function buildCapacityRow(person) {
  const row = document.createElement("tr");
  row.dataset.personId = person.id;
  row.innerHTML = `
    <td>${person.name}</td>
    <td><input type="number" class="form-control form-control-sm leaves-input" value="0" min="0" /></td>
    <td class="available-days">-</td>
    <td><input type="number" class="form-control form-control-sm allocation-input" value="100" min="10" max="100" step="10" /></td>
    <td class="total-capacity">
      <div class="capacity-cell">
        <div class="capacity-value">-</div>
        <div class="util-bar">
          <div class="util-ghost"></div>
          <div class="util-fill"></div>
          <div class="util-marker"></div>
        </div>
        <div class="util-label">0%</div>
      </div>
    </td>
    <td><button class="btn btn-sm btn-outline-danger delete-person">Delete</button></td>
  `;
  return row;
}

function markDirty() {
  isDirty = true;
  updateSaveButton();
}

function markSaved() {
  isDirty = false;
  isSaved = true;
  updateSaveButton();
}

async function renderCapacityTable() {
  const tableBody = document.querySelector("#capacityTable tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  if (!currentSprint) {
    return;
  }

  await loadPeople();
  peopleCache.forEach((person) => {
    tableBody.appendChild(buildCapacityRow(person));
  });

  tableBody.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", updateCapacity);
    input.addEventListener("input", markDirty);
  });

  tableBody.querySelectorAll(".delete-person").forEach((button) => {
    button.addEventListener("click", onDeletePerson);
  });

  updateCapacity();
}

async function updateCapacity() {
  if (!currentSprint) return;
  const entries = Array.from(document.querySelectorAll("#capacityTable tbody tr")).map((row) => {
    return {
      person_id: Number(row.dataset.personId),
      leaves: Number(row.querySelector(".leaves-input").value || 0),
      allocation: Number(row.querySelector(".allocation-input").value || 100),
    };
  });

  const payload = {
    start_date: currentSprint.start_date,
    end_date: currentSprint.end_date,
    fixed_days_holiday: currentSprint.fixed_days_holiday,
    entries,
  };

  const data = await fetchJson("/api/capacity/calc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  data.entries.forEach((entry) => {
    const row = document.querySelector(`#capacityTable tbody tr[data-person-id='${entry.person_id}']`);
    if (!row) return;
    row.querySelector(".available-days").textContent = entry.available_days;
    const totalCapacity = Number(entry.total_capacity || 0);
    row.dataset.totalCapacity = totalCapacity;
    row.querySelector(".capacity-value").textContent = totalCapacity.toFixed(2);
  });

  updateUtilizationBars();
}

async function loadStories() {
  const tableBody = document.querySelector("#storyTable tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";

  if (!currentSprint) {
    return;
  }

  const includeClosed = isViewOnly || isClosureView ? "true" : "false";
  storiesCache = await fetchJson(`/api/userstory/list?sprint_id=${currentSprint.id}&include_closed=${includeClosed}`);
  storiesCache.forEach((story) => {
    const row = document.createElement("tr");
    row.dataset.storyId = story.id;
    row.dataset.backlogStoryId = story.backlog_story_id || "";
    if (story.is_closed) {
      row.classList.add("table-light", "text-muted");
    }
    const actionButton = isClosureView
      ? `<button class="btn btn-sm btn-outline-success close-story" ${story.is_closed ? "disabled" : ""}>${story.is_closed ? "Closed" : "Completed"}</button>`
      : `<button class="btn btn-sm btn-outline-danger delete-story">Delete</button>`;
    row.innerHTML = `
      <td>${story.feature_name || "Others"}</td>
      <td>${story.name}</td>
      <td>${story.story_points}</td>
      <td>${buildPeopleSelect(story.assigned_person_id)}</td>
      <td>${buildStatusSelect(story.status)}</td>
      <td>${actionButton}</td>
    `;
    tableBody.appendChild(row);
  });

  tableBody.querySelectorAll("select").forEach((select) => {
    select.addEventListener("change", updateStoryRow);
    select.addEventListener("change", markDirty);
  });

  if (isClosureView) {
    tableBody.querySelectorAll("select").forEach((select) => {
      select.setAttribute("disabled", "disabled");
    });
  }

  if (isClosureView) {
    tableBody.querySelectorAll(".close-story").forEach((button) => {
      button.addEventListener("click", onCloseStory);
    });
  } else {
    tableBody.querySelectorAll(".delete-story").forEach((button) => {
      button.addEventListener("click", onDeleteStory);
    });
  }

  updateUtilizationBars();
}

function getAssignedPointsByPerson() {
  const pointsByPerson = {};
  document.querySelectorAll("#storyTable tbody tr").forEach((row) => {
    const status = row.querySelector(".status-select")?.value || "tentative";
    if (status !== "confirmed") return;
    const points = Number(row.children[2]?.textContent || 0);
    const personId = Number(row.querySelector(".person-select")?.value || 0);
    if (!personId) return;
    pointsByPerson[personId] = (pointsByPerson[personId] || 0) + points;
  });
  return pointsByPerson;
}

function getTentativePointsByPerson() {
  const pointsByPerson = {};
  document.querySelectorAll("#storyTable tbody tr").forEach((row) => {
    const status = row.querySelector(".status-select")?.value || "tentative";
    if (status !== "tentative") return;
    const points = Number(row.children[2]?.textContent || 0);
    const personId = Number(row.querySelector(".person-select")?.value || 0);
    if (!personId) return;
    pointsByPerson[personId] = (pointsByPerson[personId] || 0) + points;
  });
  return pointsByPerson;
}

function updateUtilizationBars() {
  if (!currentSprint) return;
  const assignedPoints = getAssignedPointsByPerson();
  const tentativePoints = getTentativePointsByPerson();
  document.querySelectorAll("#capacityTable tbody tr").forEach((row) => {
    const personId = Number(row.dataset.personId);
    const totalCapacity = Number(row.dataset.totalCapacity || 0);
    const usedPoints = Number(assignedPoints[personId] || 0);
    const pendingPoints = Number(tentativePoints[personId] || 0);
    const percent = totalCapacity > 0 ? (usedPoints / totalCapacity) * 100 : 0;
    const ghostPercent = totalCapacity > 0 ? ((usedPoints + pendingPoints) / totalCapacity) * 100 : 0;
    const clamped = Math.min(percent, 100);
    const ghostClamped = Math.min(ghostPercent, 100);
    const fill = row.querySelector(".util-fill");
    const ghost = row.querySelector(".util-ghost");
    const label = row.querySelector(".util-label");
    if (!fill || !ghost || !label) return;
    fill.style.width = `${clamped}%`;
    ghost.style.width = `${ghostClamped}%`;
    const isOver = percent > 100;
    fill.classList.toggle("util-over", isOver);
    label.textContent = `${percent.toFixed(0)}%`;
    label.classList.toggle("util-over", isOver);
  });
}

function buildPeopleSelect(selectedId) {
  const options = peopleCache.map((p) => {
    const selected = Number(selectedId) === p.id ? "selected" : "";
    return `<option value="${p.id}" ${selected}>${p.name}</option>`;
  });
  return `<select class="form-select form-select-sm person-select"><option value="">Unassigned</option>${options.join("")}</select>`;
}

function buildStatusSelect(current) {
  return `
    <select class="form-select form-select-sm status-select">
      <option value="tentative" ${current === "tentative" ? "selected" : ""}>Tentative</option>
      <option value="confirmed" ${current === "confirmed" ? "selected" : ""}>Confirmed</option>
    </select>
  `;
}

async function updateStoryRow(event) {
  const row = event.target.closest("tr");
  const payload = {
    id: Number(row.dataset.storyId),
    assigned_person_id: row.querySelector(".person-select").value || null,
    status: row.querySelector(".status-select").value,
  };
  await fetchJson("/api/userstory/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  markDirty();
  updateUtilizationBars();
}

async function onDeleteStory(event) {
  const row = event.target.closest("tr");
  await fetchJson("/api/userstory/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: Number(row.dataset.storyId) }),
  });
  await loadStories();
  markDirty();
  updateUtilizationBars();
}

async function onCloseStory(event) {
  const row = event.target.closest("tr");
  const storyId = Number(row.dataset.storyId);
  const backlogStoryId = Number(row.dataset.backlogStoryId || 0);
  if (!storyId) return;
  await fetchJson("/api/userstory/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: storyId }),
  });
  if (backlogStoryId) {
    await fetchJson("/api/backlog/story/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: backlogStoryId }),
    });
  }
  await loadStories();
}

async function onDeletePerson(event) {
  const row = event.target.closest("tr");
  await fetchJson("/api/people/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: Number(row.dataset.personId) }),
  });
  await renderCapacityTable();
  await loadStories();
  markDirty();
}

async function loadProjects() {
  projectsCache = await fetchJson("/api/project/list");
  return projectsCache;
}

async function renderProjectOptions() {
  const select = document.getElementById("sprintProject");
  if (!select) return;
  await loadProjects();
  select.innerHTML = "<option value=\"\">Select project</option>";
  projectsCache.forEach((project) => {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    select.appendChild(option);
  });
}

async function renderProjectOptionsSelected(selectedId) {
  await renderProjectOptions();
  const select = document.getElementById("sprintProject");
  if (!select) return;
  select.value = selectedId ? String(selectedId) : "";
}

function formatSprintName(projectName, start, end) {
  if (!projectName || !start || !end) return "";
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return "";
  }
  const sdd = String(startDate.getDate()).padStart(2, "0");
  const smm = String(startDate.getMonth() + 1).padStart(2, "0");
  const syyyy = String(startDate.getFullYear());
  const edd = String(endDate.getDate()).padStart(2, "0");
  const emm = String(endDate.getMonth() + 1).padStart(2, "0");
  const eyyyy = String(endDate.getFullYear());
  const safeProject = projectName.trim().replace(/\s+/g, "_");
  return `${safeProject}_${sdd}_${smm}_${syyyy}_to_${edd}_${emm}_${eyyyy}`;
}

function updateSprintNameField() {
  const projectSelect = document.getElementById("sprintProject");
  const projectName = projectSelect?.selectedOptions?.[0]?.textContent || "";
  const start = document.getElementById("sprintStart").value;
  const end = document.getElementById("sprintEnd").value;
  const nameField = document.getElementById("sprintName");
  if (!nameField) return;
  nameField.value = formatSprintName(projectName, start, end);
}

function updateSprintHeading() {
  const heading = document.getElementById("sprintHeading");
  if (!heading) return;
  heading.textContent = currentSprint ? currentSprint.name : "Sprint Plan";
}

function updateSprintToggleButton() {
  const button = document.getElementById("sprintToggleBtn");
  if (!button) return;
  if (currentSprint) {
    button.textContent = "Delete Sprint";
    button.classList.remove("btn-primary");
    button.classList.add("btn-danger");
  } else {
    button.textContent = "Create New Sprint";
    button.classList.remove("btn-danger");
    button.classList.add("btn-primary");
  }
}

function updateEditButton() {
  const button = document.getElementById("editSprintBtn");
  if (!button) return;
  if (currentSprint && !isViewOnly) {
    button.removeAttribute("hidden");
  } else {
    button.setAttribute("hidden", "hidden");
  }
}

function setSprintModalMode(mode) {
  const title = document.getElementById("sprintModalTitle");
  const actionBtn = document.getElementById("createSprintBtn");
  if (!title || !actionBtn) return;
  if (mode === "edit") {
    title.textContent = "Edit Sprint";
    actionBtn.textContent = "Update Sprint";
    actionBtn.dataset.mode = "edit";
  } else {
    title.textContent = "Create New Sprint";
    actionBtn.textContent = "Create Sprint";
    actionBtn.dataset.mode = "create";
  }
}

function updateSaveButton() {
  const button = document.getElementById("saveSprintBtn");
  if (!button) return;
  if (isViewOnly || isClosureView) {
    button.disabled = true;
    return;
  }
  button.disabled = !currentSprint || !isDirty;
}

async function resetSprintView() {
  currentSprint = null;
  isDirty = false;
  isSaved = false;
  updateSprintHeading();
  updateSprintToggleButton();
  updateSaveButton();
  const capacityBody = document.querySelector("#capacityTable tbody");
  if (capacityBody) capacityBody.innerHTML = "";
  const storyBody = document.querySelector("#storyTable tbody");
  if (storyBody) storyBody.innerHTML = "";
}

function warnIfDirty(event) {
  if (!isDirty || isViewOnly) return;
  event.preventDefault();
  event.returnValue = "You have unsaved sprint data. Save it or it will be deleted.";
}

function applyViewOnlyMode() {
  if (!isViewOnly) return;
  const saveBtn = document.getElementById("saveSprintBtn");
  const toggleBtn = document.getElementById("sprintToggleBtn");
  if (saveBtn) saveBtn.classList.add("d-none");
  if (toggleBtn) toggleBtn.classList.add("d-none");
  document.querySelectorAll("#capacityTable input, #capacityTable button, #storyTable select, #storyTable button").forEach((el) => {
    el.setAttribute("disabled", "disabled");
  });
  document.querySelectorAll("[data-bs-target='#peopleModal'], [data-bs-target='#storyModal']").forEach((el) => {
    el.classList.add("d-none");
  });
}

function applyClosureMode() {
  if (!isClosureView) return;
  const saveBtn = document.getElementById("saveSprintBtn");
  const toggleBtn = document.getElementById("sprintToggleBtn");
  const editBtn = document.getElementById("editSprintBtn");
  const addPeopleBtn = document.getElementById("addPeopleBtn");
  const addStoryBtn = document.getElementById("addUserStoryBtn");
  if (saveBtn) saveBtn.classList.add("d-none");
  if (toggleBtn) toggleBtn.classList.add("d-none");
  if (editBtn) editBtn.classList.add("d-none");
  if (addPeopleBtn) addPeopleBtn.classList.add("d-none");
  if (addStoryBtn) addStoryBtn.classList.add("d-none");
  document.querySelectorAll("#storyTable select").forEach((el) => {
    el.setAttribute("disabled", "disabled");
  });
}

async function initSprintPlan() {
  const createSprintBtn = document.getElementById("createSprintBtn");
  const sprintToggleBtn = document.getElementById("sprintToggleBtn");
  const createPersonBtn = document.getElementById("createPersonBtn");
  const createStoryBtn = document.getElementById("createStoryBtn");
  const saveSprintBtn = document.getElementById("saveSprintBtn");
  const editSprintBtn = document.getElementById("editSprintBtn");
  const sprintStart = document.getElementById("sprintStart");
  const sprintEnd = document.getElementById("sprintEnd");
  const sprintContainer = document.getElementById("sprintHeading");
  const storyType = document.getElementById("storyType");
  const storyBacklogFields = document.getElementById("storyBacklogFields");
  const storyOtherFields = document.getElementById("storyOtherFields");
  const storyFeature = document.getElementById("storyFeature");
  const storyBacklog = document.getElementById("storyBacklog");
  const addPeopleBtn = document.getElementById("addPeopleBtn");
  const addUserStoryBtn = document.getElementById("addUserStoryBtn");
  if (sprintContainer) {
    isViewOnly = sprintContainer.dataset.viewOnly === "true";
    isClosureView = sprintContainer.dataset.closure === "true";
  }

  function updateSprintActionButtons() {
    const enabled = !!currentSprint && !isViewOnly && !isClosureView;
    if (addPeopleBtn) addPeopleBtn.disabled = !enabled;
    if (addUserStoryBtn) addUserStoryBtn.disabled = !enabled;
  }

  if (createSprintBtn) {
    createSprintBtn.addEventListener("click", async () => {
      const mode = createSprintBtn.dataset.mode || "create";
      const projectId = document.getElementById("sprintProject").value;
      const payload = {
        id: currentSprint?.id,
        project_id: projectId,
        name: document.getElementById("sprintName").value || "",
        start_date: document.getElementById("sprintStart").value,
        end_date: document.getElementById("sprintEnd").value,
        fixed_days_holiday: document.getElementById("fixedHolidays").value,
      };
      if (!payload.project_id || !payload.start_date || !payload.end_date || payload.fixed_days_holiday === "") {
        alert("All fields are required.");
        return;
      }
      if (!payload.name) {
        alert("Sprint name is required.");
        return;
      }
      const endpoint = mode === "edit" ? "/api/sprint/update" : "/api/sprint/create";
      currentSprint = await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      isSaved = false;
      isDirty = true;
      updateSprintHeading();
      updateSprintToggleButton();
      updateEditButton();
      updateSprintActionButtons();
      updateSaveButton();
      setSprintModalMode("create");
      const sprintModalEl = document.getElementById("sprintModal");
      if (sprintModalEl) {
        const sprintModal = bootstrap.Modal.getInstance(sprintModalEl);
        if (sprintModal) {
          sprintModal.hide();
        }
      }
      await renderCapacityTable();
      await loadStories();
      await loadBacklogFeatures();
    });
  }

  if (sprintToggleBtn) {
    sprintToggleBtn.addEventListener("click", async () => {
      if (!currentSprint) {
        await renderProjectOptions();
        updateSprintNameField();
        setSprintModalMode("create");
        const modal = new bootstrap.Modal(document.getElementById("sprintModal"));
        modal.show();
        return;
      }
      const confirmDelete = window.confirm(
        "Delete this sprint? All filled data will be removed."
      );
      if (!confirmDelete) return;
      await fetchJson("/api/sprint/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: currentSprint.id }),
      });
      await resetSprintView();
      updateSprintActionButtons();
    });
  }

  if (editSprintBtn) {
    editSprintBtn.addEventListener("click", async () => {
      if (!currentSprint) return;
      await renderProjectOptionsSelected(currentSprint.project_id);
      document.getElementById("sprintStart").value = currentSprint.start_date;
      document.getElementById("sprintEnd").value = currentSprint.end_date;
      document.getElementById("fixedHolidays").value = currentSprint.fixed_days_holiday;
      updateSprintNameField();
      setSprintModalMode("edit");
      const modal = new bootstrap.Modal(document.getElementById("sprintModal"));
      modal.show();
    });
  }

  if (saveSprintBtn) {
    saveSprintBtn.addEventListener("click", async () => {
      if (!currentSprint) return;
      const entries = Array.from(document.querySelectorAll("#capacityTable tbody tr")).map((row) => {
        return {
          person_id: Number(row.dataset.personId),
          leaves: Number(row.querySelector(".leaves-input").value || 0),
          allocation: Number(row.querySelector(".allocation-input").value || 100),
        };
      });
      await fetchJson("/api/sprint/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sprint_id: currentSprint.id, entries }),
      });
      markSaved();
      alert("Sprint saved.");
    });
  }

  if (createPersonBtn) {
    createPersonBtn.addEventListener("click", async () => {
      const name = document.getElementById("personName").value.trim();
      if (!name) return;
      await fetchJson("/api/people/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      document.getElementById("personName").value = "";
      await renderCapacityTable();
      await loadStories();
      markDirty();
      updateUtilizationBars();
    });
  }

  if (createStoryBtn) {
    createStoryBtn.addEventListener("click", async () => {
      if (!currentSprint) return;
      const selectedType = storyType?.value || "other";
      if (selectedType === "backlog") {
        if (storyFeature && storyFeature.options.length === 0) {
          await loadBacklogFeatures();
        }
        const featureName = storyFeature?.selectedOptions?.[0]?.dataset?.featureKey || "";
        const backlogStoryName = storyBacklog?.selectedOptions?.[0]?.textContent || "";
        const backlogPoints = Number(storyBacklog?.selectedOptions?.[0]?.dataset?.points || 0);
        const backlogStoryId = Number(storyBacklog?.value || 0);
        if (!featureName || !backlogStoryName || backlogPoints <= 0) return;
        await fetchJson("/api/userstory/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sprint_id: currentSprint.id,
            name: backlogStoryName,
            story_points: backlogPoints,
            feature_name: featureName,
            backlog_story_id: backlogStoryId,
          }),
        });
      } else {
        const name = document.getElementById("storyName").value.trim();
        const storyPoints = Number(document.getElementById("storyPoints").value || 0);
        if (!name || storyPoints <= 0) return;
        await fetchJson("/api/userstory/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sprint_id: currentSprint.id,
            name,
            story_points: storyPoints,
            feature_name: "Others",
          }),
        });
        document.getElementById("storyName").value = "";
        document.getElementById("storyPoints").value = "";
      }
      await loadStories();
      markDirty();
    });
  }

  if (sprintStart) {
    sprintStart.addEventListener("input", updateSprintNameField);
  }
  if (sprintEnd) {
    sprintEnd.addEventListener("input", updateSprintNameField);
  }

  async function loadBacklogFeatures() {
    if (!currentSprint || !storyFeature) return;
    const features = await fetchJson(`/api/backlog/feature/list?project_id=${currentSprint.project_id}`);
    storyFeature.innerHTML = "";
    if (features.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No features found";
      storyFeature.appendChild(option);
      if (storyBacklog) {
        storyBacklog.innerHTML = "";
      }
      return;
    }
    features.forEach((feature) => {
      const option = document.createElement("option");
      option.value = feature.id;
      const description = feature.description ? ` - ${feature.description}` : "";
      option.textContent = `${feature.feature_key}${description}`;
      option.dataset.featureKey = feature.feature_key;
      storyFeature.appendChild(option);
    });
    await loadBacklogStories();
  }

  async function loadBacklogStories() {
    if (!storyBacklog || !storyFeature) return;
    const featureId = storyFeature.value;
    if (!featureId) return;
    const stories = await fetchJson(`/api/backlog/story/by_feature?feature_id=${featureId}`);
    storyBacklog.innerHTML = "";
    stories.forEach((story) => {
      if (story.is_closed) return;
      const option = document.createElement("option");
      option.value = story.id;
      option.textContent = story.name;
      option.dataset.points = story.story_points;
      storyBacklog.appendChild(option);
    });
  }

  function toggleStoryType() {
    if (!storyType || !storyBacklogFields || !storyOtherFields) return;
    const isBacklog = storyType.value === "backlog";
    storyBacklogFields.classList.toggle("d-none", !isBacklog);
    storyOtherFields.classList.toggle("d-none", isBacklog);
  }

  if (storyType) {
    storyType.addEventListener("change", toggleStoryType);
    toggleStoryType();
  }

  if (storyFeature) {
    storyFeature.addEventListener("change", loadBacklogStories);
  }

  document.querySelectorAll("a.nav-link").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (!isDirty || isViewOnly) return;
      const confirmLeave = window.confirm(
        "You have unsaved sprint data. Save it or it will be deleted."
      );
      if (!confirmLeave) {
        event.preventDefault();
      }
    });
  });

  window.addEventListener("beforeunload", warnIfDirty);

  if (sprintContainer && sprintContainer.dataset.sprintId) {
    const sprintId = sprintContainer.dataset.sprintId;
    currentSprint = await fetchJson(`/api/sprint/get?id=${sprintId}`);
    if (currentSprint) {
      isSaved = currentSprint.is_saved;
      isDirty = false;
      updateSprintHeading();
      updateSprintToggleButton();
      await renderCapacityTable();
      const capacity = await fetchJson(`/api/capacity/get?sprint_id=${sprintId}`);
      capacity.forEach((entry) => {
        const row = document.querySelector(
          `#capacityTable tbody tr[data-person-id='${entry.person_id}']`
        );
        if (!row) return;
        row.querySelector(".leaves-input").value = entry.leaves;
        row.querySelector(".allocation-input").value = entry.allocation;
      });
      await updateCapacity();
      await loadStories();
      await loadBacklogFeatures();
      updateSaveButton();
      updateEditButton();
      updateSprintActionButtons();
      applyViewOnlyMode();
      applyClosureMode();
    }
  } else {
    updateSprintHeading();
    updateSprintToggleButton();
    updateSaveButton();
    updateEditButton();
    updateSprintActionButtons();
    await loadBacklogFeatures();
    applyViewOnlyMode();
    applyClosureMode();
  }
}

async function initPreviousSprints() {
  const tableBody = document.querySelector("#previousSprintsTable tbody");
  if (!tableBody) return;
  tableBody.innerHTML = "";
  const sprints = await fetchJson("/api/sprint/list_saved");
  sprints.forEach((sprint) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${sprint.name}</td>
      <td>${sprint.start_date}</td>
      <td>${sprint.end_date}</td>
      <td>
        <a class="btn btn-sm btn-outline-primary" href="/sprint/${sprint.id}/plan">Plan</a>
        <a class="btn btn-sm btn-outline-secondary" href="/sprint/${sprint.id}/view">View</a>
        <a class="btn btn-sm btn-outline-success" href="/sprint/${sprint.id}/closure">Closure</a>
      </td>
    `;
    tableBody.appendChild(row);
  });
}

async function initProjectsPage() {
  const createProjectBtn = document.getElementById("createProjectBtn");
  const tableBody = document.querySelector("#projectsTable tbody");

  async function renderProjectsTable() {
    if (!tableBody) return;
    tableBody.innerHTML = "";
    await loadProjects();
    projectsCache.forEach((project) => {
      const row = document.createElement("tr");
      row.innerHTML = `<td>${project.name}</td>`;
      tableBody.appendChild(row);
    });
  }

  if (createProjectBtn) {
    createProjectBtn.addEventListener("click", async () => {
      const name = document.getElementById("projectName").value.trim();
      if (!name) return;
      await fetchJson("/api/project/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      document.getElementById("projectName").value = "";
      await renderProjectsTable();
    });
  }

  await renderProjectsTable();
}

document.addEventListener("DOMContentLoaded", () => {
  if (document.getElementById("sprintHeading") || document.getElementById("storyTable")) {
    initSprintPlan();
  }
  if (document.getElementById("projectsTable")) {
    initProjectsPage();
  }
  if (document.getElementById("previousSprintsTable")) {
    initPreviousSprints();
  }
  if (document.getElementById("featureTable")) {
    initProjectPlan();
  }
  if (document.getElementById("piPlanHeading")) {
    initPiPlan();
  }
});

async function initPiPlan() {
  const piPlanHeading = document.getElementById("piPlanHeading");
  const piPlanCreateBtn = document.getElementById("piPlanCreateBtn");
  const piPlanSaveBtn = document.getElementById("piPlanSaveBtn");
  const piPlanSaveBtnTop = document.getElementById("piPlanSaveBtnTop");
  const piPlanDeleteBtn = document.getElementById("piPlanDeleteBtn");
  const piPlanListBody = document.querySelector("#piPlanListTable tbody");
  const piProjectSelect = document.getElementById("piProjectSelect");
  const piQuarterSelect = document.getElementById("piQuarterSelect");
  const piYearSelect = document.getElementById("piYearSelect");
  const piPlanName = document.getElementById("piPlanName");
  const teamAddBtn = document.getElementById("teamAddBtn");
  const teamTableBody = document.querySelector("#teamTable tbody");
  const teamSaveBtn = document.getElementById("teamSaveBtn");
  const teamModalTitle = document.getElementById("teamModalTitle");
  const sameProductivityBtn = document.getElementById("sameProductivityBtn");
  const avgProd = document.getElementById("avgProd");
  const techList = document.getElementById("techList");
  const addTechBtn = document.getElementById("addTechBtn");

  let currentPiPlan = null;
  let techItems = [];

  function formatPiName(projectName, year, quarter) {
    if (!projectName || !year || !quarter) return "";
    const safeProject = projectName.replace(/\s+/g, "");
    const yy = String(year).slice(-2);
    return `${safeProject}_CY${yy}${quarter}`;
  }

  function updatePiName() {
    const projectName = piProjectSelect?.selectedOptions?.[0]?.textContent || "";
    const year = piYearSelect?.value || "";
    const quarter = piQuarterSelect?.value || "";
    if (piPlanName) {
      piPlanName.value = formatPiName(projectName, year, quarter);
    }
  }

  async function loadProjects() {
    const projects = await fetchJson("/api/project/list");
    piProjectSelect.innerHTML = "<option value=\"\">Select project</option>";
    projects.forEach((project) => {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      piProjectSelect.appendChild(option);
    });
  }

  function populateYears() {
    piYearSelect.innerHTML = "<option value=\"\">Select year</option>";
    for (let year = 2024; year <= 2030; year += 1) {
      const option = document.createElement("option");
      option.value = String(year);
      option.textContent = String(year);
      piYearSelect.appendChild(option);
    }
  }

  function setTeamButtonState(enabled) {
    teamAddBtn.disabled = !enabled;
    if (piPlanSaveBtnTop) piPlanSaveBtnTop.disabled = !enabled;
    if (piPlanDeleteBtn) piPlanDeleteBtn.disabled = !enabled;
  }

  function getProductivityValues() {
    const values = [1, 2, 3, 4, 5, 6].map((index) => {
      const value = Number(document.getElementById(`prod${index}`).value || 0);
      return value;
    });
    return values;
  }

  function updateAverageProductivity() {
    const values = getProductivityValues();
    const avg = values.reduce((sum, val) => sum + val, 0) / 6;
    avgProd.value = avg.toFixed(2);
  }

  function renderTechList() {
    techList.innerHTML = "";
    techItems.forEach((item, index) => {
      const badge = document.createElement("span");
      badge.className = "badge text-bg-light border me-2 mb-2";
      badge.textContent = `${item.name} (${item.experience})`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "btn btn-sm btn-link text-danger ms-1 p-0";
      removeBtn.textContent = "x";
      removeBtn.addEventListener("click", () => {
        techItems.splice(index, 1);
        renderTechList();
      });
      badge.appendChild(removeBtn);
      techList.appendChild(badge);
    });
  }

  function resetTeamModal() {
    document.getElementById("teamName").value = "";
    document.getElementById("teamRole").value = "";
    document.getElementById("teamAllocation").value = "";
    [1, 2, 3, 4, 5, 6].forEach((index) => {
      document.getElementById(`prod${index}`).value = "";
    });
    avgProd.value = "";
    document.getElementById("safetyCertified").value = "false";
    document.getElementById("trainingDone").value = "false";
    document.getElementById("monthsWorked").value = "";
    document.getElementById("deliveredUs").value = "false";
    document.getElementById("techName").value = "";
    document.getElementById("techExp").value = "";
    techItems = [];
    renderTechList();
  }

  function setTeamModal(mode, member) {
    teamModalTitle.textContent = mode === "edit" ? "Edit Team Member" : "Add Team Member";
    teamSaveBtn.dataset.mode = mode;
    teamSaveBtn.dataset.memberId = member ? member.id : "";
    if (mode === "edit" && member) {
      document.getElementById("teamName").value = member.name;
      document.getElementById("teamRole").value = member.role;
      document.getElementById("teamAllocation").value = member.allocation;
      document.getElementById("prod1").value = member.sprint1;
      document.getElementById("prod2").value = member.sprint2;
      document.getElementById("prod3").value = member.sprint3;
      document.getElementById("prod4").value = member.sprint4;
      document.getElementById("prod5").value = member.sprint5;
      document.getElementById("prod6").value = member.sprint6;
      updateAverageProductivity();
      document.getElementById("safetyCertified").value = String(member.safety_certified);
      document.getElementById("trainingDone").value = String(member.training_done);
      document.getElementById("monthsWorked").value = member.months_worked || "";
      document.getElementById("deliveredUs").value = String(member.delivered_us);
      techItems = member.technologies || [];
      renderTechList();
    } else {
      resetTeamModal();
    }
  }

  function buildOptionalSummary(member) {
    const parts = [];
    if (member.technologies && member.technologies.length) {
      const techLabel = member.technologies
        .map((t) => `${t.name} (${t.experience})`)
        .join(", ");
      parts.push(`Tech: ${techLabel}`);
    }
    parts.push(`Safety: ${member.safety_certified ? "Yes" : "No"}`);
    parts.push(`Training: ${member.training_done ? "Yes" : "No"}`);
    if (member.months_worked !== null && member.months_worked !== undefined && member.months_worked !== "") {
      parts.push(`Months: ${member.months_worked}`);
    }
    parts.push(`Delivered: ${member.delivered_us ? "Yes" : "No"}`);
    return parts.join(" | ");
  }

  async function loadTeamMembers() {
    if (!currentPiPlan) return;
    const members = await fetchJson(`/api/pi/team/list?pi_plan_id=${currentPiPlan.id}`);
    teamTableBody.innerHTML = "";
    members.forEach((member) => {
      const row = document.createElement("tr");
      row.dataset.memberId = member.id;
      row.innerHTML = `
        <td>${member.name}</td>
        <td>${member.role}</td>
        <td>${member.allocation}%</td>
        <td>${Number(member.avg_productivity).toFixed(2)}</td>
        <td>${buildOptionalSummary(member)}</td>
        <td>
          <button class="btn btn-sm btn-outline-primary team-edit">Edit</button>
          <button class="btn btn-sm btn-outline-danger team-delete">Delete</button>
        </td>
      `;
      row.dataset.member = JSON.stringify(member);
      teamTableBody.appendChild(row);
    });

    teamTableBody.querySelectorAll(".team-edit").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        const row = event.target.closest("tr");
        const member = JSON.parse(row.dataset.member || "{}");
        setTeamModal("edit", member);
        const modal = new bootstrap.Modal(document.getElementById("teamModal"));
        modal.show();
      });
    });

    teamTableBody.querySelectorAll(".team-delete").forEach((btn) => {
      btn.addEventListener("click", async (event) => {
        const confirmDelete = window.confirm("Are you sure you want to delete?");
        if (!confirmDelete) return;
        const row = event.target.closest("tr");
        await fetchJson("/api/pi/team/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: Number(row.dataset.memberId) }),
        });
        await loadTeamMembers();
      });
    });
  }

  async function loadPiPlanList() {
    if (!piPlanListBody) return;
    piPlanListBody.innerHTML = "";
    const plans = await fetchJson("/api/pi/plan/list");
    plans.forEach((plan) => {
      const row = document.createElement("tr");
      row.dataset.planId = plan.id;
      row.innerHTML = `
        <td>${plan.name}</td>
        <td>${plan.project_name}</td>
        <td>${plan.saved_at ? plan.saved_at.slice(0, 10) : ""}</td>
        <td><button class="btn btn-sm btn-outline-primary pi-plan-open">Open</button></td>
      `;
      piPlanListBody.appendChild(row);
    });
    piPlanListBody.querySelectorAll(".pi-plan-open").forEach((btn) => {
      btn.addEventListener("click", onOpenPlan);
    });
  }

  async function onOpenPlan(event) {
    const row = event.target.closest("tr");
    const planId = Number(row.dataset.planId);
    const plan = await fetchJson(`/api/pi/plan/get?id=${planId}`);
    if (!plan) return;
    currentPiPlan = plan;
    piPlanHeading.textContent = plan.name;
    setTeamButtonState(true);
    await loadTeamMembers();
  }

  if (piPlanCreateBtn) {
    piPlanCreateBtn.addEventListener("click", async () => {
      await loadProjects();
      populateYears();
      updatePiName();
      const modal = new bootstrap.Modal(document.getElementById("piPlanModal"));
      modal.show();
    });
  }

  if (piProjectSelect) {
    piProjectSelect.addEventListener("change", updatePiName);
  }
  if (piQuarterSelect) {
    piQuarterSelect.addEventListener("change", updatePiName);
  }
  if (piYearSelect) {
    piYearSelect.addEventListener("change", updatePiName);
  }

  if (piPlanSaveBtn) {
    piPlanSaveBtn.addEventListener("click", async () => {
      const payload = {
        project_id: piProjectSelect.value,
        quarter: piQuarterSelect.value,
        year: piYearSelect.value,
      };
      if (!payload.project_id || !payload.quarter || !payload.year) {
        alert("All fields are required.");
        return;
      }
      currentPiPlan = await fetchJson("/api/pi/plan/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      piPlanHeading.textContent = currentPiPlan.name;
      setTeamButtonState(true);
      await loadTeamMembers();
      await loadPiPlanList();
      const modalEl = document.getElementById("piPlanModal");
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
    });
  }

  if (piPlanSaveBtnTop) {
    piPlanSaveBtnTop.addEventListener("click", async () => {
      if (!currentPiPlan) return;
      await fetchJson("/api/pi/plan/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: currentPiPlan.id }),
      });
      await loadPiPlanList();
    });
  }

  if (piPlanDeleteBtn) {
    piPlanDeleteBtn.addEventListener("click", async () => {
      if (!currentPiPlan) return;
      const confirmDelete = window.confirm("Are you sure you want to delete?");
      if (!confirmDelete) return;
      await fetchJson("/api/pi/plan/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: currentPiPlan.id }),
      });
      currentPiPlan = null;
      piPlanHeading.textContent = "PI Plan";
      setTeamButtonState(false);
      if (teamTableBody) teamTableBody.innerHTML = "";
      await loadPiPlanList();
    });
  }

  if (teamAddBtn) {
    teamAddBtn.addEventListener("click", () => {
      setTeamModal("create");
      const modal = new bootstrap.Modal(document.getElementById("teamModal"));
      modal.show();
    });
  }

  if (sameProductivityBtn) {
    sameProductivityBtn.addEventListener("click", () => {
      const value = document.getElementById("prod1").value;
      [2, 3, 4, 5, 6].forEach((index) => {
        document.getElementById(`prod${index}`).value = value;
      });
      updateAverageProductivity();
    });
  }

  [1, 2, 3, 4, 5, 6].forEach((index) => {
    document.getElementById(`prod${index}`).addEventListener("input", updateAverageProductivity);
  });

  if (addTechBtn) {
    addTechBtn.addEventListener("click", () => {
      const name = document.getElementById("techName").value.trim();
      const experience = document.getElementById("techExp").value.trim();
      if (!name || !experience) return;
      techItems.push({ name, experience });
      document.getElementById("techName").value = "";
      document.getElementById("techExp").value = "";
      renderTechList();
    });
  }

  if (teamSaveBtn) {
    teamSaveBtn.addEventListener("click", async () => {
      if (!currentPiPlan) return;
      const payload = {
        pi_plan_id: currentPiPlan.id,
        name: document.getElementById("teamName").value.trim(),
        role: document.getElementById("teamRole").value,
        allocation: document.getElementById("teamAllocation").value,
        sprints: getProductivityValues(),
        technologies: techItems,
        safety_certified: document.getElementById("safetyCertified").value === "true",
        training_done: document.getElementById("trainingDone").value === "true",
        months_worked: document.getElementById("monthsWorked").value || null,
        delivered_us: document.getElementById("deliveredUs").value === "true",
      };
      if (!payload.name || !payload.role || !payload.allocation) {
        alert("All mandatory fields are required.");
        return;
      }
      const endpoint = teamSaveBtn.dataset.mode === "edit" ? "/api/pi/team/update" : "/api/pi/team/create";
      if (teamSaveBtn.dataset.mode === "edit") {
        payload.id = Number(teamSaveBtn.dataset.memberId);
      }
      await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const modalEl = document.getElementById("teamModal");
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
      await loadTeamMembers();
    });
  }

  const existing = await fetchJson("/api/pi/plan/current");
  if (existing) {
    currentPiPlan = existing;
    piPlanHeading.textContent = existing.name;
    setTeamButtonState(true);
    await loadTeamMembers();
  } else {
    setTeamButtonState(false);
  }

  await loadPiPlanList();
}

async function initProjectPlan() {
  const backlogSelectBtn = document.getElementById("backlogSelectBtn");
  const backlogProjectCreateBtn = document.getElementById("backlogProjectCreateBtn");
  const backlogProjectSelect = document.getElementById("backlogProjectSelect");
  const backlogInfo = document.getElementById("backlogProjectInfo");
  const backlogSaveBtn = document.getElementById("backlogSaveBtn");
  const backlogDeleteBtn = document.getElementById("backlogDeleteBtn");
  const backlogListBody = document.querySelector("#backlogListTable tbody");
  const featureCardTitle = document.getElementById("featureCardTitle");
  const storyCardTitle = document.getElementById("storyCardTitle");
  const featureCreateBtn = document.getElementById("featureCreateBtn");
  const featureSaveBtn = document.getElementById("featureSaveBtn");
  const featureCsvInput = document.getElementById("featureCsvInput");
  const featureCsvBtn = document.getElementById("featureCsvBtn");
  const storyCreateBtn = document.getElementById("storyCreateBtn");
  const storySaveBtn = document.getElementById("storySaveBtn");
  const storyFeatureSelect = document.getElementById("storyFeatureSelect");
  const storySize = document.getElementById("storySize");
  const storyDays = document.getElementById("storyDays");
  const storyCsvInput = document.getElementById("storyCsvInput");
  const storyCsvBtn = document.getElementById("storyCsvBtn");
  const backlogStorySearch = document.getElementById("backlogStorySearch");
  const backlogError = document.getElementById("backlogError");
  const backlogErrorList = document.getElementById("backlogErrorList");

  let currentProject = null;
  let featuresCache = [];

  function setBacklogActionsEnabled(enabled) {
    backlogSaveBtn.disabled = !enabled;
    backlogDeleteBtn.disabled = !enabled;
    featureCreateBtn.disabled = !enabled;
    storyCreateBtn.disabled = !enabled;
    if (featureCsvBtn) featureCsvBtn.classList.toggle("disabled", !enabled);
    if (storyCsvBtn) storyCsvBtn.classList.toggle("disabled", !enabled);
  }

  function updateBacklogTitles() {
    if (!featureCardTitle || !storyCardTitle) return;
    if (currentProject) {
      featureCardTitle.textContent = `${currentProject.name} Feature IDs`;
      storyCardTitle.textContent = `${currentProject.name} User Stories`;
    } else {
      featureCardTitle.textContent = "Feature IDs";
      storyCardTitle.textContent = "User Stories";
    }
  }

  async function loadBacklogProjects() {
    const projects = await fetchJson("/api/backlog/project/list");
    backlogProjectSelect.innerHTML = "<option value=\"\">Select project</option>";
    projects.forEach((project) => {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      backlogProjectSelect.appendChild(option);
    });
  }

  async function loadFeatures() {
    if (!currentProject) return;
    const features = await fetchJson(`/api/backlog/feature/list?project_id=${currentProject.id}`);
    featuresCache = features;
    const body = document.querySelector("#featureTable tbody");
    body.innerHTML = "";
    features.forEach((feature) => {
      const row = document.createElement("tr");
      row.dataset.featureId = feature.id;
      row.innerHTML = `
        <td>${feature.feature_key}</td>
        <td>${feature.description}</td>
        <td>${feature.days}</td>
        <td>
          <button class="btn btn-sm btn-outline-primary feature-edit">Edit</button>
          <button class="btn btn-sm btn-outline-danger feature-delete">Delete</button>
        </td>
      `;
      body.appendChild(row);
    });

    body.querySelectorAll(".feature-edit").forEach((btn) => {
      btn.addEventListener("click", onEditFeature);
    });
    body.querySelectorAll(".feature-delete").forEach((btn) => {
      btn.addEventListener("click", onDeleteFeature);
    });

    storyFeatureSelect.innerHTML = "";
    features.forEach((feature) => {
      const option = document.createElement("option");
      option.value = feature.id;
      option.textContent = feature.feature_key;
      storyFeatureSelect.appendChild(option);
    });
  }

  async function loadStories() {
    if (!currentProject) return;
    const stories = await fetchJson(`/api/backlog/story/list?project_id=${currentProject.id}`);
    stories.sort((a, b) => Number(a.is_closed) - Number(b.is_closed));
    const body = document.querySelector("#backlogStoryTable tbody");
    body.innerHTML = "";
    stories.forEach((story) => {
      const feature = featuresCache.find((f) => f.id === story.feature_id);
      const row = document.createElement("tr");
      row.dataset.storyId = story.id;
      if (story.is_closed) {
        row.classList.add("table-light", "text-muted");
      }
      const statusButton = story.is_closed
        ? `<button class="btn btn-sm btn-outline-secondary story-open">Open</button>`
        : `<button class="btn btn-sm btn-outline-success story-complete">Complete</button>`;
      row.innerHTML = `
        <td>${feature ? feature.feature_key : ""}</td>
        <td>${story.name}</td>
        <td>${story.tshirt_size}</td>
        <td>${story.story_points}</td>
        <td>${story.days}</td>
        <td>
          ${statusButton}
          <button class="btn btn-sm btn-outline-danger story-delete">Delete</button>
        </td>
      `;
      body.appendChild(row);
    });
    body.querySelectorAll(".story-delete").forEach((btn) => {
      btn.addEventListener("click", onDeleteStory);
    });
    body.querySelectorAll(".story-complete").forEach((btn) => {
      btn.addEventListener("click", onCompleteStory);
    });
    body.querySelectorAll(".story-open").forEach((btn) => {
      btn.addEventListener("click", onOpenStory);
    });
    applyStoryFilter();
  }

  async function refreshBacklog() {
    await loadFeatures();
    await loadStories();
  }

  function applyStoryFilter() {
    const query = backlogStorySearch?.value?.trim().toLowerCase() || "";
    const rows = document.querySelectorAll("#backlogStoryTable tbody tr");
    rows.forEach((row) => {
      const storyCell = row.children[1]?.textContent?.toLowerCase() || "";
      row.classList.toggle("d-none", query && !storyCell.includes(query));
    });
  }

  function showBacklogErrors(errors) {
    if (!backlogError || !backlogErrorList) return;
    backlogErrorList.innerHTML = "";
    if (!errors || errors.length === 0) {
      backlogError.classList.add("d-none");
      return;
    }
    errors.forEach((message) => {
      const li = document.createElement("li");
      li.textContent = message;
      backlogErrorList.appendChild(li);
    });
    backlogError.classList.remove("d-none");
  }

  async function loadSavedBacklogs() {
    if (!backlogListBody) return;
    backlogListBody.innerHTML = "";
    const items = await fetchJson("/api/backlog/saved/list");
    items.forEach((item) => {
      const row = document.createElement("tr");
      row.dataset.projectId = item.project_id;
      row.innerHTML = `
        <td>${item.project_name}</td>
        <td>${item.saved_at ? item.saved_at.slice(0, 10) : ""}</td>
        <td>
          <button class="btn btn-sm btn-outline-primary backlog-edit">Edit</button>
          <button class="btn btn-sm btn-outline-danger backlog-delete">Delete</button>
        </td>
      `;
      backlogListBody.appendChild(row);
    });
    backlogListBody.querySelectorAll(".backlog-edit").forEach((btn) => {
      btn.addEventListener("click", onEditBacklog);
    });
    backlogListBody.querySelectorAll(".backlog-delete").forEach((btn) => {
      btn.addEventListener("click", onDeleteBacklog);
    });
  }

  function updateStoryDays() {
    const size = storySize.value;
    const sizeMap = { XS: 2, S: 3, M: 5 };
    storyDays.value = sizeMap[size] || 0;
  }

  function setFeatureModal(mode, feature) {
    const title = document.getElementById("featureModalTitle");
    if (mode === "edit") {
      title.textContent = "Edit FeatureID";
      featureSaveBtn.textContent = "Update";
      featureSaveBtn.dataset.mode = "edit";
      featureSaveBtn.dataset.featureId = feature.id;
      document.getElementById("featureKey").value = feature.feature_key;
      document.getElementById("featureDesc").value = feature.description;
    } else {
      title.textContent = "Create FeatureID";
      featureSaveBtn.textContent = "Create";
      featureSaveBtn.dataset.mode = "create";
      featureSaveBtn.dataset.featureId = "";
      document.getElementById("featureKey").value = "";
      document.getElementById("featureDesc").value = "";
    }
  }

  async function onEditFeature(event) {
    const row = event.target.closest("tr");
    const featureId = Number(row.dataset.featureId);
    const feature = featuresCache.find((f) => f.id === featureId);
    if (!feature) return;
    setFeatureModal("edit", feature);
    const modal = new bootstrap.Modal(document.getElementById("featureModal"));
    modal.show();
  }

  async function onDeleteFeature(event) {
    const row = event.target.closest("tr");
    const confirmDelete = window.confirm("Are you sure you want to delete?");
    if (!confirmDelete) return;
    await fetchJson("/api/backlog/feature/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: Number(row.dataset.featureId) }),
    });
    await refreshBacklog();
  }

  async function onDeleteStory(event) {
    const row = event.target.closest("tr");
    const confirmDelete = window.confirm("Are you sure you want to delete?");
    if (!confirmDelete) return;
    await fetchJson("/api/backlog/story/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: Number(row.dataset.storyId) }),
    });
    await refreshBacklog();
  }

  async function onCompleteStory(event) {
    const row = event.target.closest("tr");
    await fetchJson("/api/backlog/story/close", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: Number(row.dataset.storyId) }),
    });
    await refreshBacklog();
  }

  async function onOpenStory(event) {
    const row = event.target.closest("tr");
    await fetchJson("/api/backlog/story/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: Number(row.dataset.storyId) }),
    });
    await refreshBacklog();
  }

  if (backlogSelectBtn) {
    backlogSelectBtn.addEventListener("click", async () => {
      await loadBacklogProjects();
      const modal = new bootstrap.Modal(document.getElementById("backlogSelectModal"));
      modal.show();
    });
  }

  if (backlogProjectCreateBtn) {
    backlogProjectCreateBtn.addEventListener("click", async () => {
      const projectId = backlogProjectSelect.value;
      if (!projectId) return;
      const projectName = backlogProjectSelect.selectedOptions[0]?.textContent || "";
      currentProject = { id: Number(projectId), name: projectName };
      backlogInfo.textContent = `Backlog for ${projectName}`;
      setBacklogActionsEnabled(true);
      updateBacklogTitles();
      await fetchJson("/api/backlog/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: currentProject.id }),
      });
      await refreshBacklog();
      await loadSavedBacklogs();
      const modalEl = document.getElementById("backlogSelectModal");
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
    });
  }

  async function onEditBacklog(event) {
    const row = event.target.closest("tr");
    const projectId = Number(row.dataset.projectId);
    const projectName = row.children[0]?.textContent || "";
    currentProject = { id: projectId, name: projectName };
    backlogInfo.textContent = `Backlog for ${projectName}`;
    setBacklogActionsEnabled(true);
    updateBacklogTitles();
    await refreshBacklog();
  }

  async function onDeleteBacklog(event) {
    const row = event.target.closest("tr");
    const confirmDelete = window.confirm("Are you sure you want to delete?");
    if (!confirmDelete) return;
    await fetchJson("/api/backlog/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: Number(row.dataset.projectId) }),
    });
    if (currentProject && currentProject.id === Number(row.dataset.projectId)) {
      currentProject = null;
      backlogInfo.textContent = "Select a project to start.";
      setBacklogActionsEnabled(false);
      updateBacklogTitles();
      updateBacklogTitles();
      const featureBody = document.querySelector("#featureTable tbody");
      const storyBody = document.querySelector("#backlogStoryTable tbody");
      if (featureBody) featureBody.innerHTML = "";
      if (storyBody) storyBody.innerHTML = "";
    }
    await loadSavedBacklogs();
  }

  if (featureCreateBtn) {
    featureCreateBtn.addEventListener("click", () => {
      setFeatureModal("create");
      const modal = new bootstrap.Modal(document.getElementById("featureModal"));
      modal.show();
    });
  }

  if (featureSaveBtn) {
    featureSaveBtn.addEventListener("click", async () => {
      if (!currentProject) return;
      const featureKey = document.getElementById("featureKey").value.trim();
      const description = document.getElementById("featureDesc").value.trim();
      if (!featureKey || !description) return;
      const mode = featureSaveBtn.dataset.mode || "create";
      const payload = {
        project_id: currentProject.id,
        feature_key: featureKey,
        description,
      };
      let endpoint = "/api/backlog/feature/create";
      if (mode === "edit") {
        endpoint = "/api/backlog/feature/update";
        payload.id = Number(featureSaveBtn.dataset.featureId);
      }
      await fetchJson(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await refreshBacklog();
      const modalEl = document.getElementById("featureModal");
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
    });
  }

  if (featureCsvInput) {
    featureCsvInput.addEventListener("change", async () => {
      if (!currentProject || !featureCsvInput.files.length) return;
      const formData = new FormData();
      formData.append("project_id", currentProject.id);
      formData.append("file", featureCsvInput.files[0]);
      const res = await fetch("/api/backlog/feature/import", {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        showBacklogErrors(data.errors || []);
      } else {
        showBacklogErrors(["Import failed. Check the CSV and try again."]);
      }
      featureCsvInput.value = "";
      await refreshBacklog();
    });
  }

  if (backlogSaveBtn) {
    backlogSaveBtn.addEventListener("click", async () => {
      if (!currentProject) return;
      await fetchJson("/api/backlog/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: currentProject.id }),
      });
      await loadSavedBacklogs();
    });
  }

  if (backlogDeleteBtn) {
    backlogDeleteBtn.addEventListener("click", async () => {
      if (!currentProject) return;
      const confirmDelete = window.confirm("Are you sure you want to delete?");
      if (!confirmDelete) return;
      await fetchJson("/api/backlog/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: currentProject.id }),
      });
      currentProject = null;
      backlogInfo.textContent = "Select a project to start.";
      setBacklogActionsEnabled(false);
      const featureBody = document.querySelector("#featureTable tbody");
      const storyBody = document.querySelector("#backlogStoryTable tbody");
      if (featureBody) featureBody.innerHTML = "";
      if (storyBody) storyBody.innerHTML = "";
      await loadSavedBacklogs();
    });
  }

  if (storyCreateBtn) {
    storyCreateBtn.addEventListener("click", () => {
      updateStoryDays();
      const modal = new bootstrap.Modal(document.getElementById("backlogStoryModal"));
      modal.show();
    });
  }

  if (storyCsvInput) {
    storyCsvInput.addEventListener("change", async () => {
      if (!currentProject || !storyCsvInput.files.length) return;
      const formData = new FormData();
      formData.append("project_id", currentProject.id);
      formData.append("file", storyCsvInput.files[0]);
      const res = await fetch("/api/backlog/story/import", {
        method: "POST",
        body: formData,
      });
      if (res.ok) {
        const data = await res.json();
        showBacklogErrors(data.errors || []);
      } else {
        showBacklogErrors(["Import failed. Check the CSV and try again."]);
      }
      storyCsvInput.value = "";
      await refreshBacklog();
    });
  }

  if (storySize) {
    storySize.addEventListener("change", updateStoryDays);
  }

  if (storySaveBtn) {
    storySaveBtn.addEventListener("click", async () => {
      if (!currentProject) return;
      const payload = {
        feature_id: Number(storyFeatureSelect.value),
        name: document.getElementById("storyTitle").value.trim(),
        tshirt_size: storySize.value,
      };
      if (!payload.feature_id || !payload.name) return;
      await fetchJson("/api/backlog/story/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      document.getElementById("storyTitle").value = "";
      await refreshBacklog();
      const modalEl = document.getElementById("backlogStoryModal");
      const modal = bootstrap.Modal.getInstance(modalEl);
      if (modal) modal.hide();
    });
  }

  if (backlogStorySearch) {
    backlogStorySearch.addEventListener("input", applyStoryFilter);
  }

  setBacklogActionsEnabled(false);
  updateBacklogTitles();
  await loadSavedBacklogs();
}
