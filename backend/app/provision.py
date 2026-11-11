"""Issue/revoke a device key. Plaintext is shown once; only its hash is stored."""
import argparse
import hashlib
import re
import secrets
from .db import APIKey, SessionLocal


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--owner', required=True)
    parser.add_argument('--device', required=True)
    parser.add_argument('--revoke', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', args.owner) or not 1 <= len(args.device) <= 128:
        parser.error('Invalid owner/device')
    with SessionLocal.begin() as db:
        if args.revoke:
            from sqlalchemy import delete
            db.execute(delete(APIKey).where(APIKey.owner == args.owner, APIKey.device == args.device))
            print('Device keys revoked')
        else:
            token = secrets.token_urlsafe(32)
            db.add(APIKey(digest=hashlib.sha256(token.encode()).hexdigest(), owner=args.owner, device=args.device))
            print(token)


if __name__ == '__main__':
    main()
