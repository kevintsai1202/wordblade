package com.wordblade.gateway.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/** 驗證 Authorization: Bearer 權杖；通過後把身分放進 request 屬性。 */
@Component
public class TokenAuthInterceptor implements HandlerInterceptor {

    /** request 屬性名稱：通過驗證的 TokenService.TokenInfo。 */
    public static final String ATTR = "wordblade.token";

    private final TokenService tokens;

    public TokenAuthInterceptor(TokenService tokens) {
        this.tokens = tokens;
    }

    /** 缺少、格式錯誤、查無或已停用一律回 401（不透露原因）；預檢請求放行。 */
    @Override
    public boolean preHandle(HttpServletRequest req, HttpServletResponse res, Object handler) throws Exception {
        if (HttpMethod.OPTIONS.matches(req.getMethod())) return true;
        String h = req.getHeader("Authorization");
        if (h != null && h.regionMatches(true, 0, "Bearer ", 0, 7)) {
            var info = tokens.authenticate(h.substring(7).trim());
            if (info.isPresent()) {
                req.setAttribute(ATTR, info.get());
                return true;
            }
        }
        res.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
        res.setContentType("application/json");
        res.getWriter().write("{\"error\":\"unauthorized\"}");
        return false;
    }
}
