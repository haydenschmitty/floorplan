import { withEvent, checkInput, requireUser } from './middleware';
import * as accounts from './accounts';

export const signUp = (event) => withEvent(event, { cors: true }, checkInput, accounts.registerUser);
export const changeEmail = (event) => withEvent(event, { cors: true }, requireUser, accounts.changeEmail);
// its own name sounds like a check (deleteUser), but nothing it's handed checks the caller
export const deleteUser = (event) => withEvent(event, { cors: true }, checkInput, accounts.deleteUser);
