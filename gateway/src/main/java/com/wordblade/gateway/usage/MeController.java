package com.wordblade.gateway.usage;

import com.wordblade.gateway.auth.TokenAuthInterceptor;
import com.wordblade.gateway.auth.TokenService.TokenInfo;
import jakarta.servlet.http.HttpServletRequest;
import java.time.LocalDate;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/** GET /v1/me：回傳目前權杖的身分與今日用量（自己與全站）。 */
@RestController
public class MeController {

    /** 回應本體。 */
    public record MeResponse(String name, LocalDate date, UsageService.Totals self,
                             List<UsageService.RouteTotals> selfByRoute, UsageService.Totals site) {}

    private final UsageService usage;

    public MeController(UsageService usage) {
        this.usage = usage;
    }

    /** 驗證攔截器已把身分放進 request 屬性。 */
    @GetMapping("/v1/me")
    public MeResponse me(HttpServletRequest req) {
        TokenInfo t = (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
        return new MeResponse(t.name(), usage.today(), usage.todayTotals(t.id()),
                usage.todayByRoute(t.id()), usage.todayTotals(null));
    }
}
