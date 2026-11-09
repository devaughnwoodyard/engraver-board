# Ivelisse Board

QR guest form → iPad board → live status page, for Ivelisse Designs events.

- `#/admin` — staff: create events, QR codes, example photos
- `#/board/<event>` — iPad board (drag cards, or use the Move menu on a phone)
- `#/e/<event>` — guest form (what the QR opens)
- `#/o/<event>/<order>` — guest status page

Backend: Firebase project `ivelisse-board` (Firestore + Auth). Rules in `firestore.rules`.
Staff = Google accounts listed in the Firestore `staff` collection (doc id = email).
Publish changes: `bash publish.sh`
