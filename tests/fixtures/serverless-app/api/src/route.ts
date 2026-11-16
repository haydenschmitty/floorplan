import { withEvent, checkInput, requireUser } from './middleware';
import * as accounts from './accounts';

export const signUp = (event) => withEvent(event, { cors: true }, checkInput, accounts.registerUser);
export const changeEmail = (event) => withEvent(event, { cors: true }, requireUser, accounts.changeEmail);
