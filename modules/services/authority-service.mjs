export function selectAuthorityUser(users) {
  // Every client elects the same connected GM without another socket roundtrip.
  // Stable ID ordering avoids two GMs both acting as the writer or clock owner.
  return [...users]
    .filter((user) => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
}

export class AuthorityService {
  static get user() {
    return selectAuthorityUser(game.users);
  }

  static get userId() {
    return this.user?.id ?? null;
  }

  static get isCurrentUser() {
    return this.userId === game.user.id;
  }
}
