package com.wordblade.gateway.vibe;

import java.util.List;

/** 模型回應不合格式：帶結構化錯誤清單，回饋給模型重寫。 */
public class VibeSchemaException extends RuntimeException {

    private final transient List<VibeError> errors;

    public VibeSchemaException(List<VibeError> errors) {
        super(errors.isEmpty() ? "invalid response" : errors.get(0).message());
        this.errors = List.copyOf(errors);
    }

    /** 結構化錯誤 */
    public List<VibeError> errors() {
        return errors;
    }
}
