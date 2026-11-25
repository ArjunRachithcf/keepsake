// Anonymous questions (ADR 0008) and ideas (spec §3). Who may ask, answer, remove or see is questions/questions.ts's
// and ideas/ideas.ts's; what comes back is the view layer's, for the request's person, and never names an asker.
import type { Data } from '../data';
import type { Router } from '../router';
import { newWish, object, text, WISH_FIELDS } from '../validate';

export function questionRoutes(api: Router, data: Data) {
  api.post('/people/:personId/questions', (r, res) => {
    const q = data.questions.ask(r, r.params.personId, text(object(r.body, ['text']), 'text', 200, { required: true })!);
    res.created();
    return data.view(r).question(q);
  });

  api.delete('/questions/:questionId', (r) => data.questions.remove(r, r.params.questionId));

  api.post('/questions/:questionId/answer', (r) => data.questions.answer(r, r.params.questionId, text(object(r.body, ['text']), 'text', 500, { required: true })!));

  api.post('/questions/:questionId/decline', (r) => data.questions.decline(r, r.params.questionId));

  api.post('/questions/:questionId/wish', (r, res) => {
    const wishId = data.questions.withWish(r, r.params.questionId, newWish(object(r.body, WISH_FIELDS)));
    res.created();
    return data.view(r).wish(wishId);
  });

  api.post('/people/:personId/ideas', (r, res) => {
    const id = data.ideas.add(r, r.params.personId, text(object(r.body, ['text']), 'text', 200, { required: true })!);
    res.created();
    return data.view(r).idea(id);
  });

  api.delete('/ideas/:ideaId', (r) => data.ideas.remove(r, r.params.ideaId));
}
