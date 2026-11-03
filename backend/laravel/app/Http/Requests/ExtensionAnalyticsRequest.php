<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class ExtensionAnalyticsRequest extends FormRequest
{
    public function rules(): array
    {
        return ['client_id' => ['required', 'uuid']];
    }
}
