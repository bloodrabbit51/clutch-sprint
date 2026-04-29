from datetime import datetime, timedelta
import json
import csv
import hashlib
import secrets
from io import BytesIO, StringIO, TextIOWrapper
from flask import Flask, render_template, request, redirect, session, jsonify, url_for, send_from_directory, send_file
from openpyxl import Workbook
from werkzeug.security import generate_password_hash, check_password_hash
from models import (
    db,
    User,
    Sprint,
    Person,
    Holiday,
    UserStory,
    Project,
    SprintCapacity,
    BacklogFeature,
    BacklogMeta,
    BacklogStory,
    PIPlan,
    PITeamMember,
    PasswordResetToken,
)


app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///sprintstream.db"
app.config["SQLALCHEMY_BINDS"] = {"backlog": "sqlite:///backlog.db"}
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = "dev-secret-change-me"
app.config["ADMIN_USERNAME"] = "admin"
app.config["ADMIN_PASSWORD"] = "qorix123"
app.config["RESET_TOKEN_EXPIRY_HOURS"] = 24

db.init_app(app)


def init_db():
    with app.app_context():
        db.create_all()


def login_required(view_func):
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login"))
        return view_func(*args, **kwargs)

    wrapped.__name__ = view_func.__name__
    return wrapped


def admin_required(view_func):
    def wrapped(*args, **kwargs):
        if not session.get("is_admin"):
            return redirect(url_for("admin"))
        return view_func(*args, **kwargs)

    wrapped.__name__ = view_func.__name__
    return wrapped


@app.route("/")
def index():
    if "user_id" in session:
        return redirect(url_for("dashboard"))
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        user = User.query.filter_by(username=username).first()
        if user and check_password_hash(user.password_hash, password):
            session["user_id"] = user.id
            session["username"] = user.username
            return redirect(url_for("dashboard"))
        return render_template("login.html", error="Invalid credentials")
    return render_template("login.html")


@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip()
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        if not all([name, email, username, password]):
            return render_template("register.html", error="All fields are required")
        if User.query.filter((User.email == email) | (User.username == username)).first():
            return render_template("register.html", error="User already exists")
        user = User(
            name=name,
            email=email,
            username=username,
            password_hash=generate_password_hash(password),
        )
        db.session.add(user)
        db.session.commit()
        return redirect(url_for("login"))
    return render_template("register.html")


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/admin", methods=["GET", "POST"])
def admin():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        if username == app.config["ADMIN_USERNAME"] and password == app.config["ADMIN_PASSWORD"]:
            session["is_admin"] = True
            return redirect(url_for("admin"))
        return render_template("admin_login.html", error="Invalid credentials")

    if not session.get("is_admin"):
        return render_template("admin_login.html")

    users = User.query.order_by(User.created_at.desc()).all()
    summary = {}
    for user in users:
        summary[user.id] = {
            "projects": Project.query.filter_by(created_by=user.id).count(),
            "sprints": Sprint.query.filter_by(created_by=user.id).count(),
        }
    return render_template("admin.html", users=users, summary=summary)


@app.post("/admin/logout")
def admin_logout():
    session.pop("is_admin", None)
    return redirect(url_for("admin"))


def hash_reset_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def delete_user_data(user_id):
    sprints = Sprint.query.filter_by(created_by=user_id).all()
    sprint_ids = [sprint.id for sprint in sprints]
    if sprint_ids:
        UserStory.query.filter(UserStory.sprint_id.in_(sprint_ids)).delete(synchronize_session=False)
        Holiday.query.filter(Holiday.sprint_id.in_(sprint_ids)).delete(synchronize_session=False)
        SprintCapacity.query.filter(SprintCapacity.sprint_id.in_(sprint_ids)).delete(synchronize_session=False)
        Sprint.query.filter(Sprint.id.in_(sprint_ids)).delete(synchronize_session=False)

    Person.query.filter_by(created_by=user_id).delete(synchronize_session=False)
    Project.query.filter_by(created_by=user_id).delete(synchronize_session=False)

    BacklogStory.query.filter_by(created_by=user_id).delete(synchronize_session=False)
    BacklogFeature.query.filter_by(created_by=user_id).delete(synchronize_session=False)
    BacklogMeta.query.filter_by(created_by=user_id).delete(synchronize_session=False)

    plans = PIPlan.query.filter_by(created_by=user_id).all()
    plan_ids = [plan.id for plan in plans]
    if plan_ids:
        PITeamMember.query.filter(PITeamMember.pi_plan_id.in_(plan_ids)).delete(synchronize_session=False)
        PIPlan.query.filter(PIPlan.id.in_(plan_ids)).delete(synchronize_session=False)

    PasswordResetToken.query.filter_by(user_id=user_id).delete(synchronize_session=False)


@app.post("/admin/user/<int:user_id>/delete")
@admin_required
def admin_delete_user(user_id):
    user = User.query.get(int(user_id))
    if not user:
        return redirect(url_for("admin"))
    delete_user_data(user.id)
    db.session.delete(user)
    db.session.commit()
    return redirect(url_for("admin"))


@app.post("/admin/user/<int:user_id>/reset")
@admin_required
def admin_reset_user(user_id):
    user = User.query.get(int(user_id))
    if not user:
        return jsonify({"error": "Not found"}), 404
    raw_token = secrets.token_urlsafe(32)
    token = PasswordResetToken(
        user_id=user.id,
        token_hash=hash_reset_token(raw_token),
        expires_at=datetime.utcnow() + timedelta(hours=app.config["RESET_TOKEN_EXPIRY_HOURS"]),
    )
    db.session.add(token)
    db.session.commit()
    reset_link = url_for("reset_password", token=raw_token, _external=True)
    return jsonify({"link": reset_link})


@app.get("/admin/user/<int:user_id>/summary")
@admin_required
def admin_user_summary(user_id):
    user = User.query.get(int(user_id))
    if not user:
        return jsonify({"error": "Not found"}), 404
    project_count = Project.query.filter_by(created_by=user.id).count()
    sprint_count = Sprint.query.filter_by(created_by=user.id).count()
    return jsonify({"projects": project_count, "sprints": sprint_count})


@app.route("/reset/<token>", methods=["GET", "POST"])
def reset_password(token):
    token_hash = hash_reset_token(token)
    record = PasswordResetToken.query.filter_by(token_hash=token_hash, used_at=None).first()
    if not record or record.expires_at < datetime.utcnow():
        return render_template("reset_password.html", error="This link is invalid or expired.")

    if request.method == "POST":
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")
        if not password or password != confirm:
            return render_template("reset_password.html", error="Passwords must match.")
        user = User.query.get(int(record.user_id))
        if not user:
            return render_template("reset_password.html", error="User not found.")
        user.password_hash = generate_password_hash(password)
        record.used_at = datetime.utcnow()
        db.session.commit()
        return render_template("reset_password.html", success="Password updated. You can log in now.")

    return render_template("reset_password.html")


@app.route("/dashboard")
@login_required
def dashboard():
    user_id = session["user_id"]
    projects = Project.query.filter_by(created_by=user_id).order_by(Project.name).all()
    sprint_counts = []
    for project in projects:
        sprint_counts.append({
            "project": project.name,
            "count": Sprint.query.filter_by(project_id=project.id, created_by=user_id).count(),
        })
    max_sprints = max([item["count"] for item in sprint_counts], default=0)

    features = BacklogFeature.query.filter_by(created_by=user_id).order_by(BacklogFeature.project_name, BacklogFeature.feature_key).all()
    feature_ids = [feature.id for feature in features]
    totals_map = {}
    remaining_map = {}
    if feature_ids:
        total_rows = (
            db.session.query(BacklogStory.feature_id, db.func.sum(BacklogStory.story_points))
            .filter(BacklogStory.feature_id.in_(feature_ids), BacklogStory.created_by == user_id)
            .group_by(BacklogStory.feature_id)
            .all()
        )
        totals_map = {row[0]: int(row[1] or 0) for row in total_rows}

        remaining_rows = (
            db.session.query(BacklogStory.feature_id, db.func.sum(BacklogStory.story_points))
            .filter(
                BacklogStory.feature_id.in_(feature_ids),
                BacklogStory.created_by == user_id,
                BacklogStory.is_closed.is_(False),
            )
            .group_by(BacklogStory.feature_id)
            .all()
        )
        remaining_map = {row[0]: int(row[1] or 0) for row in remaining_rows}

    feature_progress = {}
    for feature in features:
        total = totals_map.get(feature.id, 0)
        remaining = remaining_map.get(feature.id, 0)
        percent = 0
        if total > 0:
            percent = int(round(((total - remaining) / total) * 100))
        feature_progress.setdefault(feature.project_name, []).append({
            "feature_key": feature.feature_key,
            "description": feature.description,
            "total": total,
            "remaining": remaining,
            "percent": percent,
        })

    feature_cards = []
    for project_name, items in feature_progress.items():
        total_days = sum(item["total"] for item in items)
        remaining_days = sum(item["remaining"] for item in items)
        overall_percent = 0
        if total_days > 0:
            overall_percent = int(round(((total_days - remaining_days) / total_days) * 100))
        feature_cards.append({
            "project": project_name,
            "total": total_days,
            "remaining": remaining_days,
            "percent": overall_percent,
            "features": items,
        })
    feature_cards.sort(key=lambda item: item["project"])

    return render_template(
        "dashboard.html",
        sprint_counts=sprint_counts,
        max_sprints=max_sprints,
        feature_cards=feature_cards,
    )


@app.route("/sprint")
@login_required
def sprint_plan():
    return render_template("sprint_plan.html", sprint_id=None, view_only=False, closure_view=False)


@app.route("/sprint/<int:sprint_id>/plan")
@login_required
def sprint_plan_load(sprint_id):
    return render_template("sprint_plan.html", sprint_id=sprint_id, view_only=False, closure_view=False)


@app.route("/sprint/<int:sprint_id>/view")
@login_required
def sprint_plan_view(sprint_id):
    return render_template("sprint_plan.html", sprint_id=sprint_id, view_only=True, closure_view=False)


@app.route("/sprint/<int:sprint_id>/export")
@login_required
def sprint_export(sprint_id):
    sprint = Sprint.query.get(int(sprint_id))
    if not sprint or sprint.created_by != session["user_id"]:
        return redirect(url_for("previous_sprints"))

    workbook = Workbook()
    people_sheet = workbook.active
    people_sheet.title = "People"
    people_sheet.append(["Name", "Leaves", "Allocation %", "Available Days", "Total Capacity"])

    entries = SprintCapacity.query.filter_by(sprint_id=sprint.id).all()
    person_ids = [entry.person_id for entry in entries]
    people = Person.query.filter(Person.id.in_(person_ids)).all() if person_ids else []
    people_by_id = {person.id: person.name for person in people}
    total_days = count_working_days(sprint.start_date, sprint.end_date)
    total_days = max(total_days - int(sprint.fixed_days_holiday or 0), 0)

    for entry in sorted(entries, key=lambda e: people_by_id.get(e.person_id, "")):
        available = max(total_days - int(entry.leaves or 0), 0)
        total_capacity = round(available * (int(entry.allocation or 0) / 100.0), 2)
        people_sheet.append([
            people_by_id.get(entry.person_id, ""),
            int(entry.leaves or 0),
            int(entry.allocation or 0),
            available,
            total_capacity,
        ])

    story_sheet = workbook.create_sheet("User Stories")
    story_sheet.append(["Feature", "User Story", "Points", "Assigned", "Status", "Closed"])
    stories = UserStory.query.filter_by(sprint_id=sprint.id).all()
    assigned_ids = [story.assigned_person_id for story in stories if story.assigned_person_id]
    assigned_people = Person.query.filter(Person.id.in_(assigned_ids)).all() if assigned_ids else []
    assigned_by_id = {person.id: person.name for person in assigned_people}

    for story in stories:
        story_sheet.append([
            story.feature_name or "",
            story.name,
            int(story.story_points or 0),
            assigned_by_id.get(story.assigned_person_id, "") if story.assigned_person_id else "",
            story.status,
            "Yes" if story.is_closed else "No",
        ])

    buffer = BytesIO()
    workbook.save(buffer)
    buffer.seek(0)
    filename = f"{sprint.name}_export.xlsx"
    return send_file(
        buffer,
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.route("/sprint/<int:sprint_id>/closure")
@login_required
def sprint_plan_closure(sprint_id):
    return render_template("sprint_plan.html", sprint_id=sprint_id, view_only=False, closure_view=True)


@app.route("/projects")
@login_required
def projects():
    return render_template("projects.html")


@app.route("/project-plan")
@login_required
def project_plan():
    return render_template("project_plan.html")


@app.route("/pi-plan")
@login_required
def pi_plan():
    return render_template("pi_plan.html")


@app.route("/previous-sprints")
@login_required
def previous_sprints():
    return render_template("previous_sprints.html")


@app.route("/template")
@login_required
def template_page():
    return render_template("template.html")


@app.route("/templates/<path:filename>")
@login_required
def download_template(filename):
    return send_from_directory("static/templates", filename, as_attachment=True)


@app.post("/api/pi/plan/create")
@login_required
def api_pi_plan_create():
    data = request.get_json(force=True)
    project_id = data.get("project_id")
    quarter = (data.get("quarter") or "").strip().upper()
    year = data.get("year")
    if not all([project_id, quarter, year]):
        return jsonify({"error": "All fields are required"}), 400
    project = Project.query.get(int(project_id))
    if not project or project.created_by != session["user_id"]:
        return jsonify({"error": "Invalid project"}), 400
    if quarter not in ["Q1", "Q2", "Q3", "Q4"]:
        return jsonify({"error": "Invalid quarter"}), 400
    year_int = int(year)
    name = format_pi_name(project.name, year_int, quarter)
    plan = PIPlan(
        project_id=project.id,
        project_name=project.name,
        quarter=quarter,
        year=year_int,
        name=name,
        is_saved=False,
        created_by=session["user_id"],
    )
    db.session.add(plan)
    db.session.commit()
    return jsonify({
        "id": plan.id,
        "name": plan.name,
        "project_id": plan.project_id,
        "project_name": plan.project_name,
        "quarter": plan.quarter,
        "year": plan.year,
        "is_saved": plan.is_saved,
    })


@app.get("/api/pi/plan/current")
@login_required
def api_pi_plan_current():
    plan = PIPlan.query.filter_by(created_by=session["user_id"]).order_by(PIPlan.created_at.desc()).first()
    if not plan:
        return jsonify(None)
    return jsonify({
        "id": plan.id,
        "name": plan.name,
        "project_id": plan.project_id,
        "project_name": plan.project_name,
        "quarter": plan.quarter,
        "year": plan.year,
        "is_saved": plan.is_saved,
    })


@app.get("/api/pi/plan/get")
@login_required
def api_pi_plan_get():
    plan_id = request.args.get("id")
    plan = PIPlan.query.get(int(plan_id)) if plan_id else None
    if not plan or plan.created_by != session["user_id"]:
        return jsonify(None)
    return jsonify({
        "id": plan.id,
        "name": plan.name,
        "project_id": plan.project_id,
        "project_name": plan.project_name,
        "quarter": plan.quarter,
        "year": plan.year,
        "is_saved": plan.is_saved,
    })


@app.post("/api/pi/plan/save")
@login_required
def api_pi_plan_save():
    data = request.get_json(force=True)
    plan = PIPlan.query.get(int(data.get("id")))
    if not plan or plan.created_by != session["user_id"]:
        return jsonify({"error": "Not found"}), 404
    plan.is_saved = True
    plan.saved_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/pi/plan/delete")
@login_required
def api_pi_plan_delete():
    data = request.get_json(force=True)
    plan = PIPlan.query.get(int(data.get("id")))
    if not plan or plan.created_by != session["user_id"]:
        return jsonify({"error": "Not found"}), 404
    PITeamMember.query.filter_by(pi_plan_id=plan.id).delete()
    db.session.delete(plan)
    db.session.commit()
    return jsonify({"ok": True})


@app.get("/api/pi/plan/list")
@login_required
def api_pi_plan_list():
    plans = PIPlan.query.filter_by(created_by=session["user_id"], is_saved=True).order_by(PIPlan.saved_at.desc()).all()
    return jsonify([
        {
            "id": plan.id,
            "name": plan.name,
            "project_name": plan.project_name,
            "quarter": plan.quarter,
            "year": plan.year,
            "saved_at": plan.saved_at.isoformat() if plan.saved_at else None,
        }
        for plan in plans
    ])


@app.get("/api/pi/team/list")
@login_required
def api_pi_team_list():
    plan_id = request.args.get("pi_plan_id")
    if not plan_id:
        return jsonify([])
    plan = PIPlan.query.get(int(plan_id))
    if not plan or plan.created_by != session["user_id"]:
        return jsonify([])
    members = PITeamMember.query.filter_by(pi_plan_id=plan.id).order_by(PITeamMember.created_at.desc()).all()
    return jsonify([
        {
            "id": m.id,
            "name": m.name,
            "role": m.role,
            "allocation": m.allocation,
            "sprint1": m.sprint1,
            "sprint2": m.sprint2,
            "sprint3": m.sprint3,
            "sprint4": m.sprint4,
            "sprint5": m.sprint5,
            "sprint6": m.sprint6,
            "avg_productivity": m.avg_productivity,
            "technologies": json.loads(m.technologies) if m.technologies else [],
            "safety_certified": m.safety_certified,
            "training_done": m.training_done,
            "months_worked": m.months_worked,
            "delivered_us": m.delivered_us,
        }
        for m in members
    ])


@app.post("/api/pi/team/create")
@login_required
def api_pi_team_create():
    data = request.get_json(force=True)
    plan_id = data.get("pi_plan_id")
    name = (data.get("name") or "").strip()
    role = (data.get("role") or "").strip()
    allocation = data.get("allocation")
    sprints = data.get("sprints") or []
    if not plan_id or not name or not role or allocation is None or len(sprints) != 6:
        return jsonify({"error": "All fields are required"}), 400
    plan = PIPlan.query.get(int(plan_id))
    if not plan or plan.created_by != session["user_id"]:
        return jsonify({"error": "Invalid plan"}), 400
    sprint_vals = [float(v) for v in sprints]
    avg = sum(sprint_vals) / 6.0
    member = PITeamMember(
        pi_plan_id=plan.id,
        name=name,
        role=role,
        allocation=int(allocation),
        sprint1=sprint_vals[0],
        sprint2=sprint_vals[1],
        sprint3=sprint_vals[2],
        sprint4=sprint_vals[3],
        sprint5=sprint_vals[4],
        sprint6=sprint_vals[5],
        avg_productivity=avg,
        technologies=json.dumps(data.get("technologies") or []),
        safety_certified=bool(data.get("safety_certified")),
        training_done=bool(data.get("training_done")),
        months_worked=data.get("months_worked"),
        delivered_us=bool(data.get("delivered_us")),
        created_by=session["user_id"],
    )
    db.session.add(member)
    db.session.commit()
    return jsonify({"id": member.id})


@app.post("/api/pi/team/update")
@login_required
def api_pi_team_update():
    data = request.get_json(force=True)
    member = PITeamMember.query.get(int(data.get("id")))
    if not member:
        return jsonify({"error": "Not found"}), 404
    plan = PIPlan.query.get(member.pi_plan_id)
    if not plan or plan.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    name = (data.get("name") or "").strip()
    role = (data.get("role") or "").strip()
    allocation = data.get("allocation")
    sprints = data.get("sprints") or []
    if not name or not role or allocation is None or len(sprints) != 6:
        return jsonify({"error": "All fields are required"}), 400
    sprint_vals = [float(v) for v in sprints]
    avg = sum(sprint_vals) / 6.0
    member.name = name
    member.role = role
    member.allocation = int(allocation)
    member.sprint1 = sprint_vals[0]
    member.sprint2 = sprint_vals[1]
    member.sprint3 = sprint_vals[2]
    member.sprint4 = sprint_vals[3]
    member.sprint5 = sprint_vals[4]
    member.sprint6 = sprint_vals[5]
    member.avg_productivity = avg
    member.technologies = json.dumps(data.get("technologies") or [])
    member.safety_certified = bool(data.get("safety_certified"))
    member.training_done = bool(data.get("training_done"))
    member.months_worked = data.get("months_worked")
    member.delivered_us = bool(data.get("delivered_us"))
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/pi/team/delete")
@login_required
def api_pi_team_delete():
    data = request.get_json(force=True)
    member = PITeamMember.query.get(int(data.get("id")))
    if not member:
        return jsonify({"error": "Not found"}), 404
    plan = PIPlan.query.get(member.pi_plan_id)
    if not plan or plan.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    db.session.delete(member)
    db.session.commit()
    return jsonify({"ok": True})


def format_pi_name(project_name, year, quarter):
    safe_project = project_name.replace(" ", "")
    yy = str(year)[-2:]
    return f"{safe_project}_CY{yy}{quarter}"


@app.get("/api/people/list")
@login_required
def api_people_list():
    people = Person.query.filter_by(active=True, created_by=session["user_id"]).order_by(Person.name).all()
    return jsonify([{"id": p.id, "name": p.name} for p in people])


@app.post("/api/people/create")
@login_required
def api_people_create():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Name required"}), 400
    existing = Person.query.filter_by(name=name, created_by=session["user_id"]).first()
    if existing:
        return jsonify({"id": existing.id, "name": existing.name})
    person = Person(name=name, created_by=session["user_id"])
    db.session.add(person)
    db.session.commit()
    return jsonify({"id": person.id, "name": person.name})


@app.post("/api/people/delete")
@login_required
def api_people_delete():
    data = request.get_json(force=True)
    person = Person.query.get(int(data.get("id")))
    if not person:
        return jsonify({"error": "Not found"}), 404
    if person.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    person.active = False
    UserStory.query.filter_by(assigned_person_id=person.id).update({"assigned_person_id": None})
    db.session.commit()
    return jsonify({"ok": True})


@app.get("/api/project/list")
@login_required
def api_project_list():
    projects = Project.query.filter_by(created_by=session["user_id"]).order_by(Project.name).all()
    return jsonify([{"id": p.id, "name": p.name} for p in projects])


@app.get("/api/backlog/project/list")
@login_required
def api_backlog_project_list():
    projects = Project.query.filter_by(created_by=session["user_id"]).order_by(Project.name).all()
    return jsonify([{"id": p.id, "name": p.name} for p in projects])


@app.get("/api/backlog/feature/list")
@login_required
def api_backlog_feature_list():
    project_id = request.args.get("project_id")
    if not project_id:
        return jsonify([])
    features = BacklogFeature.query.filter_by(
        project_id=int(project_id),
        created_by=session["user_id"],
    ).order_by(BacklogFeature.created_at.desc()).all()
    feature_ids = [f.id for f in features]
    points_by_feature = {}
    if feature_ids:
        rows = (
            db.session.query(BacklogStory.feature_id, db.func.sum(BacklogStory.story_points))
            .filter(BacklogStory.feature_id.in_(feature_ids), BacklogStory.is_closed.is_(False))
            .group_by(BacklogStory.feature_id)
            .all()
        )
        points_by_feature = {row[0]: int(row[1] or 0) for row in rows}
    return jsonify([
        {
            "id": f.id,
            "feature_key": f.feature_key,
            "description": f.description,
            "days": points_by_feature.get(f.id, 0),
        }
        for f in features
    ])


@app.get("/api/backlog/saved/list")
@login_required
def api_backlog_saved_list():
    items = BacklogMeta.query.filter_by(created_by=session["user_id"]).order_by(BacklogMeta.saved_at.desc()).all()
    return jsonify([
        {
            "id": item.id,
            "project_id": item.project_id,
            "project_name": item.project_name,
            "saved_at": item.saved_at.isoformat() if item.saved_at else None,
        }
        for item in items
    ])


@app.post("/api/backlog/save")
@login_required
def api_backlog_save():
    data = request.get_json(force=True)
    project_id = data.get("project_id")
    if not project_id:
        return jsonify({"error": "Project required"}), 400
    project = Project.query.get(int(project_id))
    if not project or project.created_by != session["user_id"]:
        return jsonify({"error": "Invalid project"}), 400
    meta = BacklogMeta.query.filter_by(
        project_id=project.id,
        created_by=session["user_id"],
    ).first()
    if not meta:
        meta = BacklogMeta(
            project_id=project.id,
            project_name=project.name,
            created_by=session["user_id"],
        )
        db.session.add(meta)
    meta.project_name = project.name
    meta.saved_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/backlog/delete")
@login_required
def api_backlog_delete():
    data = request.get_json(force=True)
    project_id = data.get("project_id")
    if not project_id:
        return jsonify({"error": "Project required"}), 400
    BacklogStory.query.filter_by(project_id=int(project_id)).delete()
    BacklogFeature.query.filter_by(project_id=int(project_id)).delete()
    BacklogMeta.query.filter_by(project_id=int(project_id), created_by=session["user_id"]).delete()
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/backlog/feature/create")
@login_required
def api_backlog_feature_create():
    data = request.get_json(force=True)
    project_id = data.get("project_id")
    feature_key = (data.get("feature_key") or "").strip()
    description = (data.get("description") or "").strip()
    if not all([project_id, feature_key, description]):
        return jsonify({"error": "All fields are required"}), 400
    project = Project.query.get(int(project_id))
    if not project or project.created_by != session["user_id"]:
        return jsonify({"error": "Invalid project"}), 400
    feature = BacklogFeature(
        project_id=project.id,
        project_name=project.name,
        feature_key=feature_key,
        description=description,
        created_by=session["user_id"],
    )
    db.session.add(feature)
    db.session.commit()
    return jsonify({"id": feature.id})


@app.post("/api/backlog/feature/update")
@login_required
def api_backlog_feature_update():
    data = request.get_json(force=True)
    feature = BacklogFeature.query.get(int(data.get("id")))
    if not feature:
        return jsonify({"error": "Not found"}), 404
    if feature.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    feature_key = (data.get("feature_key") or "").strip()
    description = (data.get("description") or "").strip()
    if not feature_key or not description:
        return jsonify({"error": "All fields are required"}), 400
    feature.feature_key = feature_key
    feature.description = description
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/backlog/feature/delete")
@login_required
def api_backlog_feature_delete():
    data = request.get_json(force=True)
    feature = BacklogFeature.query.get(int(data.get("id")))
    if not feature:
        return jsonify({"error": "Not found"}), 404
    if feature.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    BacklogStory.query.filter_by(feature_id=feature.id).delete()
    db.session.delete(feature)
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/backlog/feature/import")
@login_required
def api_backlog_feature_import():
    project_id = request.form.get("project_id")
    csv_file = request.files.get("file")
    if not project_id or not csv_file:
        return jsonify({"error": "Project and file are required"}), 400
    project = Project.query.get(int(project_id))
    if not project or project.created_by != session["user_id"]:
        return jsonify({"error": "Invalid project"}), 400
    wrapper = TextIOWrapper(csv_file.stream, encoding="utf-8")
    reader = csv.reader(wrapper)
    first = True
    created = 0
    errors = []
    row_index = 0
    for row in reader:
        row_index += 1
        if first:
            first = False
            continue
        if len(row) < 2:
            errors.append(f"Row {row_index}: Expected 2 columns")
            continue
        feature_key = (row[0] or "").strip()
        description = (row[1] or "").strip()
        if not feature_key:
            errors.append(f"Row {row_index}: Missing Feature ID")
            continue
        if not description:
            errors.append(f"Row {row_index}: Missing Description")
            continue
        db.session.add(
            BacklogFeature(
                project_id=project.id,
                project_name=project.name,
                feature_key=feature_key,
                description=description,
                created_by=session["user_id"],
            )
        )
        created += 1
    db.session.commit()
    return jsonify({"created": created, "errors": errors})


@app.get("/api/backlog/story/list")
@login_required
def api_backlog_story_list():
    project_id = request.args.get("project_id")
    if not project_id:
        return jsonify([])
    stories = BacklogStory.query.filter_by(
        project_id=int(project_id),
        created_by=session["user_id"],
    ).order_by(BacklogStory.created_at.desc()).all()
    return jsonify([
        {
            "id": s.id,
            "feature_id": s.feature_id,
            "name": s.name,
            "tshirt_size": s.tshirt_size,
            "story_points": s.story_points,
            "days": s.days,
            "is_closed": s.is_closed,
        }
        for s in stories
    ])


@app.get("/api/backlog/story/by_feature")
@login_required
def api_backlog_story_by_feature():
    feature_id = request.args.get("feature_id")
    if not feature_id:
        return jsonify([])
    feature = BacklogFeature.query.get(int(feature_id))
    if not feature or feature.created_by != session["user_id"]:
        return jsonify([])
    stories = BacklogStory.query.filter_by(feature_id=feature.id, is_closed=False).order_by(BacklogStory.created_at.desc()).all()
    return jsonify([
        {
            "id": s.id,
            "name": s.name,
            "story_points": s.story_points,
        }
        for s in stories
    ])


@app.post("/api/backlog/story/close")
@login_required
def api_backlog_story_close():
    data = request.get_json(force=True)
    story = BacklogStory.query.get(int(data.get("id")))
    if not story:
        return jsonify({"error": "Not found"}), 404
    if story.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    story.is_closed = True
    story.closed_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/backlog/story/open")
@login_required
def api_backlog_story_open():
    data = request.get_json(force=True)
    story = BacklogStory.query.get(int(data.get("id")))
    if not story:
        return jsonify({"error": "Not found"}), 404
    if story.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    story.is_closed = False
    story.closed_at = None
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/backlog/story/create")
@login_required
def api_backlog_story_create():
    data = request.get_json(force=True)
    feature_id = data.get("feature_id")
    name = (data.get("name") or "").strip()
    tshirt_size = (data.get("tshirt_size") or "").strip().upper()
    if not all([feature_id, name, tshirt_size]):
        return jsonify({"error": "All fields are required"}), 400
    feature = BacklogFeature.query.get(int(feature_id))
    if not feature or feature.created_by != session["user_id"]:
        return jsonify({"error": "Invalid feature"}), 400
    size_map = {"XS": 2, "S": 3, "M": 5}
    if tshirt_size not in size_map:
        return jsonify({"error": "Invalid size"}), 400
    points = size_map[tshirt_size]
    story = BacklogStory(
        project_id=feature.project_id,
        feature_id=feature.id,
        name=name,
        tshirt_size=tshirt_size,
        story_points=points,
        days=points,
        created_by=session["user_id"],
    )
    db.session.add(story)
    db.session.commit()
    return jsonify({"id": story.id})


@app.post("/api/backlog/story/import")
@login_required
def api_backlog_story_import():
    project_id = request.form.get("project_id")
    csv_file = request.files.get("file")
    if not project_id or not csv_file:
        return jsonify({"error": "Project and file are required"}), 400
    project = Project.query.get(int(project_id))
    if not project or project.created_by != session["user_id"]:
        return jsonify({"error": "Invalid project"}), 400
    features = BacklogFeature.query.filter_by(
        project_id=project.id,
        created_by=session["user_id"],
    ).all()
    feature_map = {f.feature_key: f for f in features}
    wrapper = TextIOWrapper(csv_file.stream, encoding="utf-8")
    reader = csv.reader(wrapper)
    first = True
    created = 0
    errors = []
    size_map = {"XS": 2, "S": 3, "M": 5}
    row_index = 0
    for row in reader:
        row_index += 1
        if first:
            first = False
            continue
        if len(row) < 3:
            errors.append(f"Row {row_index}: Expected 3 columns")
            continue
        feature_key = (row[0] or "").strip()
        name = (row[1] or "").strip()
        tshirt_size = (row[2] or "").strip().upper()
        if not feature_key:
            errors.append(f"Row {row_index}: Missing Feature ID")
            continue
        if not name:
            errors.append(f"Row {row_index}: Missing User Story")
            continue
        if tshirt_size not in size_map:
            errors.append(f"Row {row_index}: Invalid Size '{tshirt_size}'")
            continue
        feature = feature_map.get(feature_key)
        if not feature:
            errors.append(f"Row {row_index}: Feature ID '{feature_key}' not found")
            continue
        points = size_map[tshirt_size]
        db.session.add(
            BacklogStory(
                project_id=project.id,
                feature_id=feature.id,
                name=name,
                tshirt_size=tshirt_size,
                story_points=points,
                days=points,
                created_by=session["user_id"],
            )
        )
        created += 1
    db.session.commit()
    return jsonify({"created": created, "errors": errors})


@app.post("/api/backlog/story/delete")
@login_required
def api_backlog_story_delete():
    data = request.get_json(force=True)
    story = BacklogStory.query.get(int(data.get("id")))
    if not story:
        return jsonify({"error": "Not found"}), 404
    if story.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    db.session.delete(story)
    db.session.commit()
    return jsonify({"ok": True})


@app.get("/api/backlog/export")
@login_required
def api_backlog_export():
    project_id = request.args.get("project_id")
    if not project_id:
        return jsonify({"error": "Project required"}), 400
    project = Project.query.get(int(project_id))
    if not project or project.created_by != session["user_id"]:
        return jsonify({"error": "Invalid project"}), 400
    features = BacklogFeature.query.filter_by(
        project_id=project.id,
        created_by=session["user_id"],
    ).all()
    feature_map = {f.id: f.feature_key for f in features}
    stories = BacklogStory.query.filter_by(
        project_id=project.id,
        created_by=session["user_id"],
    ).order_by(BacklogStory.created_at.desc()).all()

    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(["Feature ID", "User Story", "Size", "Points", "Days", "Closed"])
    for story in stories:
        writer.writerow([
            feature_map.get(story.feature_id, ""),
            story.name,
            story.tshirt_size,
            story.story_points,
            story.days,
            "Yes" if story.is_closed else "No",
        ])

    buffer = BytesIO(output.getvalue().encode("utf-8"))
    safe_name = project.name.replace(" ", "_")
    filename = f"{safe_name}_backlog.csv"
    return send_file(
        buffer,
        as_attachment=True,
        download_name=filename,
        mimetype="text/csv",
    )


@app.post("/api/project/create")
@login_required
def api_project_create():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Name required"}), 400
    existing = Project.query.filter_by(name=name, created_by=session["user_id"]).first()
    if existing:
        return jsonify({"id": existing.id, "name": existing.name})
    project = Project(name=name, created_by=session["user_id"])
    db.session.add(project)
    db.session.commit()
    return jsonify({"id": project.id, "name": project.name})


@app.post("/api/sprint/create")
@login_required
def api_sprint_create():
    data = request.get_json(force=True)
    project_id = data.get("project_id")
    start_raw = data.get("start_date")
    end_raw = data.get("end_date")
    fixed_raw = data.get("fixed_days_holiday")
    if not all([project_id, start_raw, end_raw]) or fixed_raw is None:
        return jsonify({"error": "All fields are required"}), 400
    start = datetime.strptime(start_raw, "%Y-%m-%d").date()
    end = datetime.strptime(end_raw, "%Y-%m-%d").date()
    fixed_days_holiday = int(fixed_raw)
    if end < start:
        return jsonify({"error": "End date must be after start"}), 400
    project = Project.query.get(int(project_id))
    if not project or project.created_by != session["user_id"]:
        return jsonify({"error": "Invalid project"}), 400
    name = format_sprint_name(project.name, start, end)
    sprint = Sprint(
        name=name,
        project_id=int(project_id),
        start_date=start,
        end_date=end,
        fixed_days_holiday=fixed_days_holiday,
        created_by=session["user_id"],
    )
    db.session.add(sprint)
    db.session.commit()
    return jsonify({
        "id": sprint.id,
        "name": sprint.name,
        "project_id": sprint.project_id,
        "is_saved": sprint.is_saved,
        "start_date": sprint.start_date.isoformat(),
        "end_date": sprint.end_date.isoformat(),
        "fixed_days_holiday": sprint.fixed_days_holiday,
    })


@app.post("/api/sprint/update")
@login_required
def api_sprint_update():
    data = request.get_json(force=True)
    sprint = Sprint.query.get(int(data.get("id")))
    if not sprint:
        return jsonify({"error": "Not found"}), 404
    if sprint.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    project_id = data.get("project_id")
    start_raw = data.get("start_date")
    end_raw = data.get("end_date")
    fixed_raw = data.get("fixed_days_holiday")
    if not all([project_id, start_raw, end_raw]) or fixed_raw is None:
        return jsonify({"error": "All fields are required"}), 400
    project = Project.query.get(int(project_id))
    if not project or project.created_by != session["user_id"]:
        return jsonify({"error": "Invalid project"}), 400
    start = datetime.strptime(start_raw, "%Y-%m-%d").date()
    end = datetime.strptime(end_raw, "%Y-%m-%d").date()
    if end < start:
        return jsonify({"error": "End date must be after start"}), 400
    sprint.project_id = int(project_id)
    sprint.start_date = start
    sprint.end_date = end
    sprint.fixed_days_holiday = int(fixed_raw)
    sprint.name = format_sprint_name(project.name, start, end)
    db.session.commit()
    return jsonify({
        "id": sprint.id,
        "name": sprint.name,
        "project_id": sprint.project_id,
        "is_saved": sprint.is_saved,
        "start_date": sprint.start_date.isoformat(),
        "end_date": sprint.end_date.isoformat(),
        "fixed_days_holiday": sprint.fixed_days_holiday,
    })


@app.get("/api/sprint/current")
@login_required
def api_sprint_current():
    sprint = Sprint.query.filter_by(created_by=session["user_id"]).order_by(Sprint.created_at.desc()).first()
    if not sprint:
        return jsonify(None)
    return jsonify({
        "id": sprint.id,
        "name": sprint.name,
        "project_id": sprint.project_id,
        "is_saved": sprint.is_saved,
        "start_date": sprint.start_date.isoformat(),
        "end_date": sprint.end_date.isoformat(),
        "fixed_days_holiday": sprint.fixed_days_holiday,
    })


@app.get("/api/sprint/get")
@login_required
def api_sprint_get():
    sprint_id = request.args.get("id")
    sprint = Sprint.query.get(int(sprint_id)) if sprint_id else None
    if not sprint:
        return jsonify(None)
    if sprint.created_by != session["user_id"]:
        return jsonify(None)
    return jsonify({
        "id": sprint.id,
        "name": sprint.name,
        "project_id": sprint.project_id,
        "is_saved": sprint.is_saved,
        "start_date": sprint.start_date.isoformat(),
        "end_date": sprint.end_date.isoformat(),
        "fixed_days_holiday": sprint.fixed_days_holiday,
    })


@app.post("/api/sprint/delete")
@login_required
def api_sprint_delete():
    data = request.get_json(force=True)
    sprint = Sprint.query.get(int(data.get("id")))
    if not sprint:
        return jsonify({"error": "Not found"}), 404
    if sprint.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    UserStory.query.filter_by(sprint_id=sprint.id).delete()
    Holiday.query.filter_by(sprint_id=sprint.id).delete()
    SprintCapacity.query.filter_by(sprint_id=sprint.id).delete()
    db.session.delete(sprint)
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/sprint/save")
@login_required
def api_sprint_save():
    data = request.get_json(force=True)
    sprint = Sprint.query.get(int(data.get("sprint_id")))
    if not sprint:
        return jsonify({"error": "Not found"}), 404
    if sprint.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    entries = data.get("entries", [])
    SprintCapacity.query.filter_by(sprint_id=sprint.id).delete()
    for entry in entries:
        db.session.add(
            SprintCapacity(
                sprint_id=sprint.id,
                person_id=int(entry.get("person_id")),
                leaves=int(entry.get("leaves", 0)),
                allocation=int(entry.get("allocation", 100)),
            )
        )
    sprint.is_saved = True
    sprint.saved_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})


@app.get("/api/sprint/list_saved")
@login_required
def api_sprint_list_saved():
    sprints = Sprint.query.filter_by(is_saved=True, created_by=session["user_id"]).order_by(Sprint.saved_at.desc()).all()
    return jsonify([
        {
            "id": s.id,
            "name": s.name,
            "start_date": s.start_date.isoformat(),
            "end_date": s.end_date.isoformat(),
            "project_id": s.project_id,
            "saved_at": s.saved_at.isoformat() if s.saved_at else None,
        }
        for s in sprints
    ])


@app.get("/api/capacity/get")
@login_required
def api_capacity_get():
    sprint_id = request.args.get("sprint_id")
    if not sprint_id:
        return jsonify([])
    sprint = Sprint.query.get(int(sprint_id))
    if not sprint or sprint.created_by != session["user_id"]:
        return jsonify([])
    entries = SprintCapacity.query.filter_by(sprint_id=int(sprint_id)).all()
    return jsonify([
        {
            "person_id": e.person_id,
            "leaves": e.leaves,
            "allocation": e.allocation,
        }
        for e in entries
    ])


@app.post("/api/capacity/calc")
@login_required
def api_capacity_calc():
    data = request.get_json(force=True)
    start = datetime.strptime(data.get("start_date"), "%Y-%m-%d").date()
    end = datetime.strptime(data.get("end_date"), "%Y-%m-%d").date()
    fixed_days_holiday = int(data.get("fixed_days_holiday", 0))
    entries = data.get("entries", [])

    total_days = count_working_days(start, end)
    total_days = max(total_days - fixed_days_holiday, 0)

    result = []
    for entry in entries:
        leaves = int(entry.get("leaves", 0))
        allocation = int(entry.get("allocation", 100))
        available = max(total_days - leaves, 0)
        total_capacity = round(available * (allocation / 100.0), 2)
        result.append({
            "person_id": entry.get("person_id"),
            "available_days": available,
            "total_capacity": total_capacity,
        })

    return jsonify({"total_days": total_days, "entries": result})


def count_working_days(start, end):
    delta = (end - start).days + 1
    working = 0
    for i in range(delta):
        day = start + timedelta(days=i)
        if day.weekday() < 5:
            working += 1
    return working


@app.get("/api/userstory/list")
@login_required
def api_userstory_list():
    sprint_id = request.args.get("sprint_id")
    include_closed = request.args.get("include_closed") == "true"
    if not sprint_id:
        return jsonify([])
    sprint = Sprint.query.get(int(sprint_id))
    if not sprint or sprint.created_by != session["user_id"]:
        return jsonify([])
    story_query = UserStory.query.filter_by(sprint_id=sprint.id)
    if not include_closed:
        story_query = story_query.filter_by(is_closed=False)
    stories = story_query.all()
    return jsonify([
        {
            "id": s.id,
            "name": s.name,
            "feature_name": s.feature_name,
            "story_points": s.story_points,
            "backlog_story_id": s.backlog_story_id,
            "is_closed": s.is_closed,
            "assigned_person_id": s.assigned_person_id,
            "status": s.status,
        }
        for s in stories
    ])


@app.post("/api/userstory/create")
@login_required
def api_userstory_create():
    data = request.get_json(force=True)
    sprint_id = int(data.get("sprint_id"))
    sprint = Sprint.query.get(sprint_id)
    if not sprint or sprint.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    name = (data.get("name") or "").strip()
    feature_name = (data.get("feature_name") or "").strip()
    backlog_story_id = data.get("backlog_story_id")
    story_points = int(data.get("story_points", 0))
    if not name or story_points <= 0:
        return jsonify({"error": "Invalid input"}), 400
    story = UserStory(
        sprint_id=sprint_id,
        name=name,
        feature_name=feature_name or None,
        backlog_story_id=int(backlog_story_id) if backlog_story_id else None,
        story_points=story_points,
        assigned_person_id=data.get("assigned_person_id"),
        status=data.get("status", "tentative"),
    )
    db.session.add(story)
    db.session.commit()
    return jsonify({"id": story.id})


@app.post("/api/userstory/update")
@login_required
def api_userstory_update():
    data = request.get_json(force=True)
    story = UserStory.query.get(int(data.get("id")))
    if not story:
        return jsonify({"error": "Not found"}), 404
    sprint = Sprint.query.get(story.sprint_id)
    if not sprint or sprint.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    story.assigned_person_id = data.get("assigned_person_id")
    story.status = data.get("status", story.status)
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/userstory/close")
@login_required
def api_userstory_close():
    data = request.get_json(force=True)
    story = UserStory.query.get(int(data.get("id")))
    if not story:
        return jsonify({"error": "Not found"}), 404
    sprint = Sprint.query.get(story.sprint_id)
    if not sprint or sprint.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    story.is_closed = True
    if story.backlog_story_id:
        backlog_story = BacklogStory.query.get(int(story.backlog_story_id))
        if backlog_story and backlog_story.created_by == session["user_id"]:
            backlog_story.is_closed = True
            backlog_story.closed_at = datetime.utcnow()
    db.session.commit()
    return jsonify({"ok": True})


@app.post("/api/userstory/delete")
@login_required
def api_userstory_delete():
    data = request.get_json(force=True)
    story = UserStory.query.get(int(data.get("id")))
    if not story:
        return jsonify({"error": "Not found"}), 404
    sprint = Sprint.query.get(story.sprint_id)
    if not sprint or sprint.created_by != session["user_id"]:
        return jsonify({"error": "Forbidden"}), 403
    db.session.delete(story)
    db.session.commit()
    return jsonify({"ok": True})


def format_sprint_name(project_name, start, end):
    safe_project = project_name.replace(" ", "_")
    return f"{safe_project}_{start.day:02d}_{start.month:02d}_{start.year}_to_{end.day:02d}_{end.month:02d}_{end.year}"


if __name__ == "__main__":
    init_db()
    app.run(debug=True)
