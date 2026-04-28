# SprintStream

## System Architecture
SprintStream uses a Jinja-REST hybrid approach. Server-rendered pages (Jinja2 templates) provide the initial layout and authenticated shell, while JavaScript (Fetch API) calls REST endpoints for interactive data updates. This keeps page navigation fast and secure while enabling real-time updates without full reloads.

- **Jinja2**: Base layout, auth forms, dashboard shell
- **REST API**: CRUD for people, sprints, holidays, user stories, and capacity calculations
- **SQLite + SQLAlchemy**: Persistence layer

## Database Schema
Tables and key fields:

- **Users**
  - id (PK)
  - name
  - email (unique)
  - username (unique)
  - password_hash
  - created_at

- **Sprints**
  - id (PK)
  - name
  - start_date
  - end_date
  - fixed_days_holiday (int)
  - created_by (FK -> Users.id)
  - created_at

- **People**
  - id (PK)
  - name (unique)
  - active (bool)
  - created_at

- **Holidays**
  - id (PK)
  - sprint_id (FK -> Sprints.id)
  - person_id (FK -> People.id, nullable)
  - date
  - reason

- **UserStories**
  - id (PK)
  - sprint_id (FK -> Sprints.id)
  - name
  - story_points (int)
  - assigned_person_id (FK -> People.id, nullable)
  - status (tentative|confirmed)
  - created_at

## API Endpoints
Auth:
- POST `/api/auth/register`
- POST `/api/auth/login`
- POST `/api/auth/logout`

People:
- GET `/api/people/list`
- POST `/api/people/create`

Sprints:
- POST `/api/sprint/create`
- GET `/api/sprint/current`

Capacity:
- POST `/api/capacity/calc`

User Stories:
- GET `/api/userstory/list`
- POST `/api/userstory/create`
- POST `/api/userstory/update`

## Run
1. Install dependencies
   - `pip install flask sqlalchemy werkzeug`
2. Run the app
   - `python app.py`
3. Open `http://127.0.0.1:5000`
