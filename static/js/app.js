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

  storiesCache = await fetchJson(`/api/userstory/list?sprint_id=${currentSprint.id}`);
  storiesCache.forEach((story) => {
    const row = document.createElement("tr");
    row.dataset.storyId = story.id;
    row.innerHTML = `
      <td>${story.name}</td>
      <td>${story.story_points}</td>
      <td>${buildPeopleSelect(story.assigned_person_id)}</td>
      <td>${buildStatusSelect(story.status)}</td>
      <td><button class="btn btn-sm btn-outline-danger delete-story">Delete</button></td>
    `;
    tableBody.appendChild(row);
  });

  tableBody.querySelectorAll("select").forEach((select) => {
    select.addEventListener("change", updateStoryRow);
    select.addEventListener("change", markDirty);
  });

  tableBody.querySelectorAll(".delete-story").forEach((button) => {
    button.addEventListener("click", onDeleteStory);
  });

  updateUtilizationBars();
}

function getAssignedPointsByPerson() {
  const pointsByPerson = {};
  document.querySelectorAll("#storyTable tbody tr").forEach((row) => {
    const status = row.querySelector(".status-select")?.value || "tentative";
    if (status !== "confirmed") return;
    const points = Number(row.children[1]?.textContent || 0);
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
    const points = Number(row.children[1]?.textContent || 0);
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
  if (isViewOnly) {
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
  if (sprintContainer) {
    isViewOnly = sprintContainer.dataset.viewOnly === "true";
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
        }),
      });
      document.getElementById("storyName").value = "";
      document.getElementById("storyPoints").value = "";
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
      updateSaveButton();
      updateEditButton();
      applyViewOnlyMode();
    }
  } else {
    updateSprintHeading();
    updateSprintToggleButton();
    updateSaveButton();
    updateEditButton();
    applyViewOnlyMode();
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
  if (document.getElementById("capacityTable")) {
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
});

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
  const storyCreateBtn = document.getElementById("storyCreateBtn");
  const storySaveBtn = document.getElementById("storySaveBtn");
  const storyFeatureSelect = document.getElementById("storyFeatureSelect");
  const storySize = document.getElementById("storySize");
  const storyDays = document.getElementById("storyDays");
  const storyCsvInput = document.getElementById("storyCsvInput");
  const backlogError = document.getElementById("backlogError");
  const backlogErrorList = document.getElementById("backlogErrorList");

  let currentProject = null;
  let featuresCache = [];

  function setBacklogActionsEnabled(enabled) {
    backlogSaveBtn.disabled = !enabled;
    backlogDeleteBtn.disabled = !enabled;
    featureCreateBtn.disabled = !enabled;
    storyCreateBtn.disabled = !enabled;
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
    const body = document.querySelector("#backlogStoryTable tbody");
    body.innerHTML = "";
    stories.forEach((story) => {
      const feature = featuresCache.find((f) => f.id === story.feature_id);
      const row = document.createElement("tr");
      row.dataset.storyId = story.id;
      row.innerHTML = `
        <td>${feature ? feature.feature_key : ""}</td>
        <td>${story.name}</td>
        <td>${story.tshirt_size}</td>
        <td>${story.story_points}</td>
        <td>${story.days}</td>
        <td><button class="btn btn-sm btn-outline-danger story-delete">Delete</button></td>
      `;
      body.appendChild(row);
    });
    body.querySelectorAll(".story-delete").forEach((btn) => {
      btn.addEventListener("click", onDeleteStory);
    });
  }

  async function refreshBacklog() {
    await loadFeatures();
    await loadStories();
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

  setBacklogActionsEnabled(false);
  updateBacklogTitles();
  await loadSavedBacklogs();
}
