from datetime import datetime
from flask_sqlalchemy import SQLAlchemy


db = SQLAlchemy()


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Sprint(db.Model):
    __tablename__ = "sprints"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    project_id = db.Column(db.Integer, db.ForeignKey("projects.id"), nullable=False)
    start_date = db.Column(db.Date, nullable=False)
    end_date = db.Column(db.Date, nullable=False)
    fixed_days_holiday = db.Column(db.Integer, default=0)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    is_saved = db.Column(db.Boolean, default=False)
    saved_at = db.Column(db.DateTime)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Person(db.Model):
    __tablename__ = "people"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    active = db.Column(db.Boolean, default=True)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Project(db.Model):
    __tablename__ = "projects"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), unique=True, nullable=False)
    created_by = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Holiday(db.Model):
    __tablename__ = "holidays"

    id = db.Column(db.Integer, primary_key=True)
    sprint_id = db.Column(db.Integer, db.ForeignKey("sprints.id"), nullable=False)
    person_id = db.Column(db.Integer, db.ForeignKey("people.id"), nullable=True)
    date = db.Column(db.Date, nullable=False)
    reason = db.Column(db.String(255))


class UserStory(db.Model):
    __tablename__ = "user_stories"

    id = db.Column(db.Integer, primary_key=True)
    sprint_id = db.Column(db.Integer, db.ForeignKey("sprints.id"), nullable=False)
    name = db.Column(db.String(200), nullable=False)
    story_points = db.Column(db.Integer, nullable=False)
    assigned_person_id = db.Column(db.Integer, db.ForeignKey("people.id"), nullable=True)
    status = db.Column(db.String(20), default="tentative")
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class SprintCapacity(db.Model):
    __tablename__ = "sprint_capacity"

    id = db.Column(db.Integer, primary_key=True)
    sprint_id = db.Column(db.Integer, db.ForeignKey("sprints.id"), nullable=False)
    person_id = db.Column(db.Integer, db.ForeignKey("people.id"), nullable=False)
    leaves = db.Column(db.Integer, default=0)
    allocation = db.Column(db.Integer, default=100)


class BacklogFeature(db.Model):
    __bind_key__ = "backlog"
    __tablename__ = "backlog_features"

    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, nullable=False)
    project_name = db.Column(db.String(120), nullable=False)
    feature_key = db.Column(db.String(120), nullable=False)
    description = db.Column(db.String(500), nullable=False)
    created_by = db.Column(db.Integer, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class BacklogMeta(db.Model):
    __bind_key__ = "backlog"
    __tablename__ = "backlog_meta"

    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, nullable=False)
    project_name = db.Column(db.String(120), nullable=False)
    created_by = db.Column(db.Integer, nullable=False)
    saved_at = db.Column(db.DateTime, default=datetime.utcnow)


class BacklogStory(db.Model):
    __bind_key__ = "backlog"
    __tablename__ = "backlog_stories"

    id = db.Column(db.Integer, primary_key=True)
    project_id = db.Column(db.Integer, nullable=False)
    feature_id = db.Column(db.Integer, nullable=False)
    name = db.Column(db.String(200), nullable=False)
    tshirt_size = db.Column(db.String(10), nullable=False)
    story_points = db.Column(db.Integer, nullable=False)
    days = db.Column(db.Integer, nullable=False)
    created_by = db.Column(db.Integer, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
