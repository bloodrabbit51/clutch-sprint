from datetime import datetime, timedelta
from flask import Flask, render_template, request, redirect, session, jsonify, url_for
from werkzeug.security import generate_password_hash, check_password_hash
from models import db, User, Sprint, Person, Holiday, UserStory, Project, SprintCapacity


app = Flask(__name__)
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///sprintstream.db"
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["SECRET_KEY"] = "dev-secret-change-me"

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


@app.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html")


@app.route("/sprint")
@login_required
def sprint_plan():
    return render_template("sprint_plan.html", sprint_id=None, view_only=False)


@app.route("/sprint/<int:sprint_id>/plan")
@login_required
def sprint_plan_load(sprint_id):
    return render_template("sprint_plan.html", sprint_id=sprint_id, view_only=False)


@app.route("/sprint/<int:sprint_id>/view")
@login_required
def sprint_plan_view(sprint_id):
    return render_template("sprint_plan.html", sprint_id=sprint_id, view_only=True)


@app.route("/projects")
@login_required
def projects():
    return render_template("projects.html")


@app.route("/previous-sprints")
@login_required
def previous_sprints():
    return render_template("previous_sprints.html")


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
    if not sprint_id:
        return jsonify([])
    sprint = Sprint.query.get(int(sprint_id))
    if not sprint or sprint.created_by != session["user_id"]:
        return jsonify([])
    stories = UserStory.query.filter_by(sprint_id=sprint.id).all()
    return jsonify([
        {
            "id": s.id,
            "name": s.name,
            "story_points": s.story_points,
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
    story_points = int(data.get("story_points", 0))
    if not name or story_points <= 0:
        return jsonify({"error": "Invalid input"}), 400
    story = UserStory(
        sprint_id=sprint_id,
        name=name,
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
