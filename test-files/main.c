#include "cms8s6990.h"
#include "my_app.h"
uint32_t Systemclock = 24000000;
int main(void) {
	App_Init();
	while (1) {
		App_Task();
	}
}
