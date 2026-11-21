# Ivelisse Board

QR guest form → iPad board → live status page, for Ivelisse Designs events.

- `#/admin` — staff: create events, QR codes, example photos
- `#/board/<event>` — iPad board (drag cards, or use the Move menu on a phone)
- `#/e/<event>` — guest form (what the QR opens)
- `#/o/<event>/<order>` — guest status page

Backend: Firebase project `ivelisse-board` (Firestore + Auth). Rules in `firestore.rules`.
Event managers = the two Google accounts in `MANAGERS` (app.js) and `isManager()` (firestore.rules). Keep them in sync.
Event staff = no Google account. They tap **Event staff** and type the event's 6-character staff code (shown on the event's setup page).
A manager can make a new code (signs out the old one) or turn on **Managers only** to close the board to staff.

- `#/staff` — event staff code entry
Publish changes: `bash publish.sh`
