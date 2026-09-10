<?php

namespace App\Http\Requests;

use App\Models\CrmMessage;
use App\Models\User;
use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreCrmMessageRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            'body' => ['required', 'string', 'max:5000'],
            'direction' => ['required', Rule::in(CrmMessage::DIRECTIONS)],
            'channel' => ['required', Rule::in(CrmMessage::CHANNELS)],
            /*
             * When it was said, not when it was typed in — these lines are
             * entered after the conversation. Sent as a full ISO timestamp
             * with the operator's offset: a bare `Y-m-d H:i` out of a
             * datetime-local input is read here in the app's timezone, which
             * is three hours away from the desk that typed it.
             */
            'sent_at' => ['nullable', 'date'],
            'follow_up' => ['nullable', 'array:title,due_at,assigned_to_user_id'],
            'follow_up.title' => ['required_with:follow_up', 'string', 'max:255'],
            'follow_up.due_at' => ['required_with:follow_up', 'date', 'after:now'],
            'follow_up.assigned_to_user_id' => ['required_with:follow_up', 'integer', Rule::in(User::crmOperators()->pluck('id')->all())],
        ];
    }
}
