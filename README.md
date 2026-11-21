# Ivelisse Orders

QR guest form → iPad board → live status page, for Ivelisse Designs events.

- `#/staff` — Event staff sign in: pick the event, pick your name, enter the event PIN once per device
- `#/admin` — Event setup (managers only): events, staff names, staff PIN, QR codes, catalog, photos
- `#/board/<event>` — board: tap a name on a queue card to assign, anyone can hold several pieces; kanban columns in landscape
- `#/e/<event>` — guest form (what the QR opens)
- `#/o/<event>/<order>` — guest status page

Backend: Firebase project `ivelisse-board` (Firestore + Auth). Rules in `firestore.rules`.
Managers = Google accounts listed in the Firestore `staff` collection (doc id = email).
Event staff = devices that signed in to an event with its PIN (`events/<id>/staffSessions/<uid>`); the PIN lives in `events/<id>/private/access`.
Publish changes: `bash publish.sh`
