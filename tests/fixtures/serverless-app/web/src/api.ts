const API = import.meta.env.VITE_API_URL;

export const listTasks = () => fetch(`${API}/tasks`).then((r) => r.json());
export const deleteTask = (id) => fetch(`${API}/tasks/${id}`, { method: 'DELETE' });
export const signUp = (body) => fetch(`${API}/account/signup`, { method: 'POST', body: JSON.stringify(body) });
