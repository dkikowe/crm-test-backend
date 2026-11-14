import type { UserRepository } from "../repositories/interfaces.js";

export class UserService {
  constructor(private readonly repository: UserRepository) {}
  list() {
    return this.repository.findAll();
  }
  findById(id: string) {
    return this.repository.findById(id);
  }
}
