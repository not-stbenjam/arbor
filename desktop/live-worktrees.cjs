"use strict";

// Rows shown while a scan is still running. Discovery first reports a folder
// by path alone; Git's registration list then supplies its identity, and
// inspection fills in the rest. Registration identity is not a disk path:
// copied repositories can retain distinct registrations for one checkout, so
// a provisional path adopts an identity only while exactly one row claims it.
class LiveWorktrees {
  #limit;
  #rows = [];
  #ids = new Map();
  #provisionalPaths = new Map();
  constructor(limit) {
    this.#limit = limit;
  }

  get rows() {
    return this.#rows;
  }

  clear() {
    this.#rows = [];
    this.#ids.clear();
    this.#provisionalPaths.clear();
  }

  // `provisional` marks a discovery row that has a path but no identity yet.
  update(worktree, provisional) {
    let index = this.#ids.get(worktree.id);
    if (index === undefined && !provisional) {
      index = this.#provisionalPaths.get(worktree.path);
      if (index != null) {
        this.#ids.delete(this.#rows[index].id);
        this.#provisionalPaths.delete(worktree.path);
      }
    }
    if (index != null) {
      this.#rows[index] = worktree;
      this.#ids.set(worktree.id, index);
      if (!provisional && this.#provisionalPaths.get(worktree.path) === index)
        this.#provisionalPaths.delete(worktree.path);
    } else if (this.#rows.length < this.#limit) {
      index = this.#rows.length;
      this.#ids.set(worktree.id, index);
      if (provisional)
        this.#provisionalPaths.set(
          worktree.path,
          this.#provisionalPaths.has(worktree.path) ? null : index,
        );
      this.#rows.push(worktree);
    }
  }
}

module.exports = { LiveWorktrees };
