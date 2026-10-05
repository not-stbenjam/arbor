"""Six scripting exercises. Deliberately restricted to the disposable review fixture."""
import csv
import datetime
import json
import os
import subprocess
import sys

folder = os.environ["ARBOR_E2E_DIRECTORY"]
cli = os.environ["ARBOR_CLI_PATH"]
if not cli.startswith(folder + os.sep):
    raise SystemExit("Use this exercise only through fixture.env")
root = os.path.join(folder, "projects")

def report(*args):
    data = json.loads(subprocess.check_output([cli, *args, "--json"]))
    if isinstance(data, dict) and data.get("warnings"):
        raise SystemExit("Incomplete scan: " + "; ".join(data["warnings"]))
    return data

mode = sys.argv[1]
if mode == "inventory":
    writer = csv.writer(sys.stdout)
    writer.writerow(["path", "branch", "activityAt", "sizeBytes", "recommended"])
    for row in report("list", "-p", root)["worktrees"]:
        writer.writerow([row[k] for k in ["path", "branch", "activityAt", "sizeBytes", "recommended"]])
elif mode == "paths":
    for row in report("list", "-p", root, "--recommended")["worktrees"]:
        sys.stdout.buffer.write(os.fsencode(row["path"]) + b"\0")
elif mode == "remote":
    rows = report("list", "--host", "review-host", "--path", "~/projects")["worktrees"]
    print(json.dumps([{"host": "review-host", "path": w["path"]} for w in rows]))
elif mode == "space":
    preview = report("clean", "-p", root)
    print(sum(w["sizeBytes"] for w in preview["worktrees"] if not w["missing"]))
elif mode == "retry":
    # Reinspect failures before retrying; never blindly add --force.
    with open(os.path.join(folder, "failed.json")) as stream:
        results = json.load(stream)
    for item in results:
        if not item["removed"]:
            print(json.dumps(report("remove", item["path"], "--recommended-only")))
elif mode == "aged":
    # Age is rechecked here, but the CLI has no atomic age expectation. This
    # demonstrates the best available recipe, not a concurrency guarantee.
    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=30)
    for row in report("list", "-p", root, "--recommended")["worktrees"]:
        at = datetime.datetime.fromisoformat(row["activityAt"].replace("Z", "+00:00"))
        if at >= cutoff:
            continue
        fresh = report("remove", row["path"], "--head", row["head"], "--recommended-only")["worktrees"][0]
        if datetime.datetime.fromisoformat(fresh["activityAt"].replace("Z", "+00:00")) < cutoff:
            print(json.dumps(report("remove", row["path"], "--head", row["head"], "--recommended-only", "--yes")))
else:
    raise SystemExit("Unknown recipe")
