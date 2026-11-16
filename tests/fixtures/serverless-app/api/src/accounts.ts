/** Creates an account. */
export async function registerUser(body) {
  return { id: 'new-user', email: body.email };
}

/** Changes the email address on an account. */
export async function changeEmail(body) {
  return { email: body.email };
}

/** Deletes an account. */
export async function deleteUser(body) {
  return { deleted: body.id };
}
